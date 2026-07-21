use chrono::Local;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const LOGS_DIR_NAME: &str = "logs";
const MAX_LOG_FILES: usize = 10;
const MAX_LOG_TOTAL_BYTES: u64 = 50 * 1024 * 1024;
const MAX_LOG_FILE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_LOG_DETAILS_CHARS: usize = 16 * 1024;
const LOG_QUEUE_CAPACITY: usize = 4096;
const FLUSH_TIMEOUT: Duration = Duration::from_secs(3);
const HIGH_SEVERITY_ENQUEUE_TIMEOUT: Duration = Duration::from_millis(50);
const MAX_REPEAT_BLOCK_LINES: usize = 8;
const REPEAT_SUMMARY_FLUSH_THRESHOLD: u64 = 10_000;

struct RunLogger {
    sender: SyncSender<LoggerMessage>,
    dropped_low_severity: Arc<AtomicU64>,
}

enum LoggerMessage {
    Record(LogRecord),
    Flush(SyncSender<()>),
}

struct LoggerWorker {
    file: File,
    logs_dir: PathBuf,
    file_stem: String,
    file_size: u64,
    part: u32,
    run_id: String,
    dropped_low_severity: Arc<AtomicU64>,
    coalescer: RepeatCoalescer,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LogRecord {
    level: String,
    component: String,
    event: String,
    details: String,
}

impl LogRecord {
    fn new(level: &str, component: &str, event: &str, details: String) -> Self {
        Self {
            level: level.to_string(),
            component: component.to_string(),
            event: event.to_string(),
            details,
        }
    }

    fn summary_with_details(&self, details: String) -> Self {
        Self {
            level: self.level.clone(),
            component: self.component.clone(),
            event: self.event.clone(),
            details,
        }
    }
}

#[derive(Debug)]
struct LineRepeat {
    record: LogRecord,
    count: u64,
}

#[derive(Debug)]
struct BlockRepeat {
    block: Vec<LogRecord>,
    count: u64,
    suppressed_lines: u64,
}

#[derive(Debug)]
struct BlockMatch {
    block: Vec<LogRecord>,
    matched: Vec<LogRecord>,
}

#[derive(Debug)]
struct RepeatCoalescer {
    recent_full_records: VecDeque<LogRecord>,
    line_repeat: Option<LineRepeat>,
    block_repeat: Option<BlockRepeat>,
    block_match: Option<BlockMatch>,
}

static LOGGER: OnceLock<RunLogger> = OnceLock::new();

pub fn logs_dir_from_app_data(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(LOGS_DIR_NAME)
}

pub fn init(app_data_dir: &Path) -> Result<(), String> {
    if LOGGER.get().is_some() {
        return Ok(());
    }

    let logs_dir = logs_dir_from_app_data(app_data_dir);
    fs::create_dir_all(&logs_dir).map_err(|e| format!("Failed creating logs dir: {e}"))?;
    prune_old_logs(&logs_dir, MAX_LOG_FILES, MAX_LOG_TOTAL_BYTES);

    let run_id = make_run_id();
    let file_stem = format!("run-{}-{}", unix_ts_millis(), run_id);
    let file_name = format!("{file_stem}.log");
    let file_path = logs_dir.join(file_name);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed creating log file {}: {e}", file_path.display()))?;
    prune_old_logs(&logs_dir, MAX_LOG_FILES, MAX_LOG_TOTAL_BYTES);

    let (sender, receiver) = mpsc::sync_channel(LOG_QUEUE_CAPACITY);
    let dropped_low_severity = Arc::new(AtomicU64::new(0));
    let logger = RunLogger {
        sender: sender.clone(),
        dropped_low_severity: dropped_low_severity.clone(),
    };
    let worker = LoggerWorker {
        file,
        logs_dir,
        file_stem,
        file_size: 0,
        part: 0,
        run_id,
        dropped_low_severity,
        coalescer: RepeatCoalescer::new(),
    };
    std::thread::Builder::new()
        .name("midimaster-logger".to_string())
        .spawn(move || worker.run(receiver))
        .map_err(|err| format!("Failed starting log writer: {err}"))?;
    if LOGGER.set(logger).is_err() {
        return Ok(());
    }

    info(
        "logger",
        "initialized",
        &format!(
            "max_files={} max_file_bytes={} max_total_bytes={} queue_capacity={}",
            MAX_LOG_FILES, MAX_LOG_FILE_BYTES, MAX_LOG_TOTAL_BYTES, LOG_QUEUE_CAPACITY
        ),
    );

    Ok(())
}

pub fn info(component: &str, event: &str, details: &str) {
    log("INFO", component, event, details);
}

pub fn warn(component: &str, event: &str, details: &str) {
    log("WARN", component, event, details);
}

pub fn error(component: &str, event: &str, details: &str) {
    log("ERROR", component, event, details);
}

pub fn debug(component: &str, event: &str, details: &str) {
    log("DEBUG", component, event, details);
}

pub(crate) fn flush_pending_repeats() {
    if let Some(logger) = LOGGER.get() {
        let started_at = Instant::now();
        let (ack_sender, ack_receiver) = mpsc::sync_channel(0);
        if send_with_timeout(
            &logger.sender,
            LoggerMessage::Flush(ack_sender),
            FLUSH_TIMEOUT,
        )
        .is_err()
        {
            eprintln!("[midimaster-log-flush-failed] writer unavailable or queue timeout");
            return;
        }
        let remaining = FLUSH_TIMEOUT.saturating_sub(started_at.elapsed());
        if remaining.is_zero() || ack_receiver.recv_timeout(remaining).is_err() {
            eprintln!("[midimaster-log-flush-failed] writer timeout");
        }
    }
}

fn send_with_timeout<T>(
    sender: &SyncSender<T>,
    mut message: T,
    timeout: Duration,
) -> Result<(), T> {
    let started_at = Instant::now();
    loop {
        match sender.try_send(message) {
            Ok(()) => return Ok(()),
            Err(TrySendError::Full(returned)) => {
                message = returned;
                if started_at.elapsed() >= timeout {
                    return Err(message);
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            Err(TrySendError::Disconnected(returned)) => return Err(returned),
        }
    }
}

fn log(level: &str, component: &str, event: &str, details: &str) {
    if level == "DEBUG" && !debug_logging_enabled() {
        return;
    }
    let record = LogRecord::new(level, component, event, sanitize(details));

    if let Some(logger) = LOGGER.get() {
        let message = LoggerMessage::Record(record.clone());
        if matches!(level, "WARN" | "ERROR") {
            if send_with_timeout(&logger.sender, message, HIGH_SEVERITY_ENQUEUE_TIMEOUT).is_ok() {
                return;
            }
        } else {
            match logger.sender.try_send(message) {
                Ok(()) => return,
                Err(TrySendError::Full(_)) => {
                    logger.dropped_low_severity.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Err(TrySendError::Disconnected(_)) => {}
            }
        }
    }

    let line = format_log_line(&record, "uninitialized");
    eprintln!("[midimaster-log-fallback] {}", line.trim_end());
}

impl LoggerWorker {
    fn run(mut self, receiver: mpsc::Receiver<LoggerMessage>) {
        while let Ok(message) = receiver.recv() {
            match message {
                LoggerMessage::Record(record) => {
                    self.flush_dropped_summary();
                    let records = self.coalescer.push(record);
                    self.write_records(records);
                }
                LoggerMessage::Flush(ack) => {
                    self.flush_dropped_summary();
                    let records = self.coalescer.flush();
                    self.write_records(records);
                    if let Err(err) = self.file.flush() {
                        eprintln!("[midimaster-log-flush-failed] {err}");
                    }
                    let _ = ack.send(());
                }
            }
        }
        self.flush_dropped_summary();
        let records = self.coalescer.flush();
        self.write_records(records);
        let _ = self.file.flush();
    }

    fn flush_dropped_summary(&mut self) {
        let dropped = self.dropped_low_severity.swap(0, Ordering::Relaxed);
        if dropped == 0 {
            return;
        }
        let record = LogRecord::new(
            "WARN",
            "logger",
            "queue_overflow",
            format!("dropped_low_severity_records={dropped}"),
        );
        let records = self.coalescer.push(record);
        self.write_records(records);
    }

    fn write_records(&mut self, records: Vec<LogRecord>) {
        for record in records {
            let line = format_log_line(&record, &self.run_id);
            if self.file_size > 0
                && self.file_size.saturating_add(line.len() as u64) > MAX_LOG_FILE_BYTES
            {
                if let Err(err) = self.rotate() {
                    eprintln!("[midimaster-log-rotate-failed] {err}");
                }
            }
            match self.file.write_all(line.as_bytes()) {
                Ok(()) => self.file_size = self.file_size.saturating_add(line.len() as u64),
                Err(err) => eprintln!(
                    "[midimaster-log-write-failed] {err}; line={}",
                    line.trim_end()
                ),
            }
        }
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file.flush()?;
        self.part = self.part.saturating_add(1);
        let file_path = self
            .logs_dir
            .join(format!("{}-part-{}.log", self.file_stem, self.part));
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path)?;
        self.file_size = 0;
        prune_old_logs(&self.logs_dir, MAX_LOG_FILES, MAX_LOG_TOTAL_BYTES);
        Ok(())
    }
}

fn debug_logging_enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        let configured = std::env::var("MIDIMASTER_LOG_LEVEL").ok();
        debug_logging_enabled_for(cfg!(debug_assertions), configured.as_deref())
    })
}

fn debug_logging_enabled_for(debug_build: bool, configured_level: Option<&str>) -> bool {
    debug_build || configured_level.is_some_and(|level| level.trim().eq_ignore_ascii_case("debug"))
}

fn format_log_line(record: &LogRecord, run_id: &str) -> String {
    format!(
        "{} | {} | run={} | {}::{} | {}\n",
        formatted_timestamp(),
        record.level,
        run_id,
        record.component,
        record.event,
        record.details
    )
}

fn sanitize(input: &str) -> String {
    input
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_LOG_DETAILS_CHARS)
        .collect()
}

fn unix_ts_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn formatted_timestamp() -> String {
    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn make_run_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[0..8].to_string()
}

fn prune_old_logs(logs_dir: &Path, keep: usize, max_total_bytes: u64) {
    let read_dir = match fs::read_dir(logs_dir) {
        Ok(dir) => dir,
        Err(_) => return,
    };

    let mut files: Vec<(PathBuf, SystemTime, u64)> = read_dir
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("log") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((
                path,
                metadata.modified().unwrap_or(UNIX_EPOCH),
                metadata.len(),
            ))
        })
        .collect();

    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    let mut retained_bytes = 0u64;
    for (index, (path, _, size)) in files.into_iter().enumerate() {
        let within_count = index < keep;
        let within_bytes = retained_bytes.saturating_add(size) <= max_total_bytes;
        if within_count && within_bytes {
            retained_bytes = retained_bytes.saturating_add(size);
        } else {
            let _ = fs::remove_file(path);
        }
    }
}

impl RepeatCoalescer {
    fn new() -> Self {
        Self {
            recent_full_records: VecDeque::new(),
            line_repeat: None,
            block_repeat: None,
            block_match: None,
        }
    }

    fn push(&mut self, record: LogRecord) -> Vec<LogRecord> {
        let mut output = Vec::new();

        if self.handle_line_repeat(&record, &mut output) {
            return output;
        }

        if self.handle_block_match(record.clone(), &mut output) {
            return output;
        }

        let block_start = self.detect_block_start(&record);
        if let Some(repeat) = self.block_repeat.as_ref() {
            let continues_same_block = block_start
                .as_ref()
                .map(|block| *block == repeat.block)
                .unwrap_or(false);
            if !continues_same_block {
                self.flush_block_repeat(&mut output);
            }
        }

        if let Some(block) = block_start {
            self.block_match = Some(BlockMatch {
                block,
                matched: vec![record],
            });
            return output;
        }

        if self
            .recent_full_records
            .back()
            .map(|last| *last == record)
            .unwrap_or(false)
        {
            self.line_repeat = Some(LineRepeat { record, count: 1 });
            return output;
        }

        self.emit_full(record, &mut output);
        output
    }

    fn flush(&mut self) -> Vec<LogRecord> {
        let mut output = Vec::new();
        self.flush_line_repeat(&mut output);

        if self.block_match.is_some() {
            self.flush_block_repeat(&mut output);
        }

        if let Some(match_state) = self.block_match.take() {
            for record in match_state.matched {
                self.emit_full(record, &mut output);
            }
        }

        self.flush_block_repeat(&mut output);
        output
    }

    fn handle_line_repeat(&mut self, record: &LogRecord, output: &mut Vec<LogRecord>) -> bool {
        let Some(repeat) = self.line_repeat.as_mut() else {
            return false;
        };

        if repeat.record == *record {
            repeat.count += 1;
            if repeat.count >= REPEAT_SUMMARY_FLUSH_THRESHOLD {
                self.flush_line_repeat(output);
            }
            return true;
        }

        self.flush_line_repeat(output);
        false
    }

    fn handle_block_match(&mut self, record: LogRecord, output: &mut Vec<LogRecord>) -> bool {
        let Some(mut match_state) = self.block_match.take() else {
            return false;
        };

        let expected = match_state.block.get(match_state.matched.len());
        if expected == Some(&record) {
            match_state.matched.push(record);
            if match_state.matched.len() == match_state.block.len() {
                self.note_block_repeat(match_state.block, output);
            } else {
                self.block_match = Some(match_state);
            }
            return true;
        }

        self.flush_block_repeat(output);
        for matched in match_state.matched {
            self.emit_full(matched, output);
        }
        self.emit_full(record, output);
        true
    }

    fn note_block_repeat(&mut self, block: Vec<LogRecord>, output: &mut Vec<LogRecord>) {
        if self
            .block_repeat
            .as_ref()
            .map(|repeat| repeat.block != block)
            .unwrap_or(false)
        {
            self.flush_block_repeat(output);
        }

        let block_len = block.len() as u64;
        match self.block_repeat.as_mut() {
            Some(repeat) => {
                repeat.count += 1;
                repeat.suppressed_lines += block_len;
            }
            None => {
                self.block_repeat = Some(BlockRepeat {
                    block,
                    count: 1,
                    suppressed_lines: block_len,
                });
            }
        }

        if self
            .block_repeat
            .as_ref()
            .map(|repeat| repeat.suppressed_lines >= REPEAT_SUMMARY_FLUSH_THRESHOLD)
            .unwrap_or(false)
        {
            self.flush_block_repeat(output);
        }
    }

    fn flush_line_repeat(&mut self, output: &mut Vec<LogRecord>) {
        let Some(repeat) = self.line_repeat.take() else {
            return;
        };

        if repeat.count > 0 {
            output.push(
                repeat
                    .record
                    .summary_with_details(format!("previous line repeated {} times", repeat.count)),
            );
        }
    }

    fn flush_block_repeat(&mut self, output: &mut Vec<LogRecord>) {
        let Some(repeat) = self.block_repeat.take() else {
            return;
        };

        if repeat.count == 0 || repeat.block.is_empty() {
            return;
        }

        output.push(repeat.block[0].summary_with_details(format!(
            "previous {}-line block repeated {} times; suppressed_lines={}",
            repeat.block.len(),
            repeat.count,
            repeat.suppressed_lines
        )));
    }

    fn emit_full(&mut self, record: LogRecord, output: &mut Vec<LogRecord>) {
        self.remember_full(record.clone());
        output.push(record);
    }

    fn remember_full(&mut self, record: LogRecord) {
        self.recent_full_records.push_back(record);
        while self.recent_full_records.len() > MAX_REPEAT_BLOCK_LINES * 2 {
            self.recent_full_records.pop_front();
        }
    }

    fn detect_block_start(&self, record: &LogRecord) -> Option<Vec<LogRecord>> {
        let max_block_len = MAX_REPEAT_BLOCK_LINES.min(self.recent_full_records.len() / 2);
        for block_len in (2..=max_block_len).rev() {
            let first_start = self.recent_full_records.len() - (block_len * 2);
            let second_start = self.recent_full_records.len() - block_len;

            let first = self
                .recent_full_records
                .iter()
                .skip(first_start)
                .take(block_len);
            let second = self
                .recent_full_records
                .iter()
                .skip(second_start)
                .take(block_len);
            let block: Vec<LogRecord> = first.cloned().collect();

            if block.first() == Some(record) && block.iter().eq(second) {
                return Some(block);
            }
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(name: &str) -> LogRecord {
        LogRecord::new(
            "DEBUG",
            "test",
            &format!("event_{}", name),
            format!("details_{}", name),
        )
    }

    fn details(records: Vec<LogRecord>) -> Vec<String> {
        records.into_iter().map(|record| record.details).collect()
    }

    fn push_names(coalescer: &mut RepeatCoalescer, names: &[&str]) -> Vec<String> {
        let mut output = Vec::new();
        for name in names {
            output.extend(coalescer.push(record(name)));
        }
        details(output)
    }

    #[test]
    fn run_logger_coalesces_exact_duplicate_lines() {
        let mut coalescer = RepeatCoalescer::new();

        assert_eq!(push_names(&mut coalescer, &["a"]), vec!["details_a"]);
        assert!(push_names(&mut coalescer, &["a", "a"]).is_empty());

        assert_eq!(
            push_names(&mut coalescer, &["b"]),
            vec!["previous line repeated 2 times", "details_b"]
        );
    }

    #[test]
    fn run_logger_flushes_pending_line_repeat() {
        let mut coalescer = RepeatCoalescer::new();

        assert_eq!(push_names(&mut coalescer, &["a"]), vec!["details_a"]);
        assert!(push_names(&mut coalescer, &["a"]).is_empty());

        assert_eq!(
            details(coalescer.flush()),
            vec!["previous line repeated 1 times"]
        );
    }

    #[test]
    fn run_logger_coalesces_repeated_three_line_block() {
        let mut coalescer = RepeatCoalescer::new();

        assert_eq!(
            push_names(&mut coalescer, &["a", "b", "c", "a", "b", "c"]),
            vec![
                "details_a",
                "details_b",
                "details_c",
                "details_a",
                "details_b",
                "details_c"
            ]
        );
        assert!(push_names(&mut coalescer, &["a", "b", "c"]).is_empty());

        assert_eq!(
            push_names(&mut coalescer, &["d"]),
            vec![
                "previous 3-line block repeated 1 times; suppressed_lines=3",
                "details_d"
            ]
        );
    }

    #[test]
    fn run_logger_coalesces_repeated_blocks_from_three_to_six_lines() {
        for block_len in 3..=6 {
            let mut coalescer = RepeatCoalescer::new();
            let block_names = ["a", "b", "c", "d", "e", "f"];
            let block = &block_names[..block_len];

            assert_eq!(push_names(&mut coalescer, block).len(), block_len);
            assert_eq!(push_names(&mut coalescer, block).len(), block_len);
            assert!(push_names(&mut coalescer, block).is_empty());

            assert_eq!(
                details(coalescer.flush()),
                vec![format!(
                    "previous {}-line block repeated 1 times; suppressed_lines={}",
                    block_len, block_len
                )]
            );
        }
    }

    #[test]
    fn run_logger_emits_partial_block_match_on_mismatch() {
        let mut coalescer = RepeatCoalescer::new();

        assert_eq!(
            push_names(&mut coalescer, &["a", "b", "c", "a", "b", "c"]).len(),
            6
        );
        assert!(push_names(&mut coalescer, &["a"]).is_empty());

        assert_eq!(
            push_names(&mut coalescer, &["x"]),
            vec!["details_a", "details_x"]
        );
        assert!(details(coalescer.flush()).is_empty());
    }

    #[test]
    fn run_logger_flushes_repeats_at_suppressed_line_threshold() {
        let mut coalescer = RepeatCoalescer::new();
        let mut output = Vec::new();

        output.extend(coalescer.push(record("a")));
        for _ in 0..REPEAT_SUMMARY_FLUSH_THRESHOLD {
            output.extend(coalescer.push(record("a")));
        }

        assert_eq!(
            details(output),
            vec![
                "details_a".to_string(),
                format!(
                    "previous line repeated {} times",
                    REPEAT_SUMMARY_FLUSH_THRESHOLD
                )
            ]
        );
    }

    #[test]
    fn log_details_are_sanitized_and_bounded() {
        let input = format!("first\nsecond\t{}", "x".repeat(MAX_LOG_DETAILS_CHARS * 2));
        let sanitized = sanitize(&input);

        assert!(!sanitized.contains(['\n', '\r', '\t']));
        assert_eq!(sanitized.chars().count(), MAX_LOG_DETAILS_CHARS);
    }

    #[test]
    fn release_logging_filters_debug_unless_explicitly_enabled() {
        assert!(!debug_logging_enabled_for(false, None));
        assert!(!debug_logging_enabled_for(false, Some("info")));
        assert!(debug_logging_enabled_for(false, Some(" DEBUG ")));
        assert!(debug_logging_enabled_for(true, None));
    }

    #[test]
    fn pruning_enforces_file_count_and_total_size() {
        let dir =
            std::env::temp_dir().join(format!("midimaster-log-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("test dir");
        for index in 0..6 {
            std::fs::write(dir.join(format!("run-{index}.log")), vec![b'x'; 16]).expect("test log");
            std::thread::sleep(Duration::from_millis(2));
        }

        prune_old_logs(&dir, 4, 48);

        let retained = std::fs::read_dir(&dir)
            .expect("read logs")
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert_eq!(retained.len(), 3);
        assert_eq!(
            retained
                .iter()
                .filter_map(|entry| entry.metadata().ok())
                .map(|metadata| metadata.len())
                .sum::<u64>(),
            48
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn async_writer_flushes_warn_and_error_records() {
        let dir =
            std::env::temp_dir().join(format!("midimaster-log-worker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("test dir");
        let path = dir.join("run-test.log");
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .expect("test log");
        let dropped = Arc::new(AtomicU64::new(0));
        let worker = LoggerWorker {
            file,
            logs_dir: dir.clone(),
            file_stem: "run-test".to_string(),
            file_size: 0,
            part: 0,
            run_id: "test".to_string(),
            dropped_low_severity: dropped,
            coalescer: RepeatCoalescer::new(),
        };
        let (sender, receiver) = mpsc::sync_channel(2);
        let thread = std::thread::spawn(move || worker.run(receiver));
        sender
            .send(LoggerMessage::Record(LogRecord::new(
                "WARN",
                "test",
                "warning",
                "preserved warning".to_string(),
            )))
            .expect("warn queued");
        sender
            .send(LoggerMessage::Record(LogRecord::new(
                "ERROR",
                "test",
                "error",
                "preserved error".to_string(),
            )))
            .expect("error queued");
        let (ack_sender, ack_receiver) = mpsc::sync_channel(0);
        sender
            .send(LoggerMessage::Flush(ack_sender))
            .expect("flush queued");
        ack_receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("flush acknowledgement");
        drop(sender);
        thread.join().expect("writer joined");

        let contents = std::fs::read_to_string(path).expect("log contents");
        assert!(contents.contains("WARN | run=test | test::warning | preserved warning"));
        assert!(contents.contains("ERROR | run=test | test::error | preserved error"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn bounded_send_times_out_when_writer_queue_is_full() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        sender.send(1).expect("fill queue");
        let started_at = Instant::now();

        assert_eq!(
            send_with_timeout(&sender, 2, Duration::from_millis(5)),
            Err(2)
        );
        assert!(started_at.elapsed() < Duration::from_millis(250));
    }
}
