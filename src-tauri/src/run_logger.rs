use chrono::Local;
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub const LOGS_DIR_NAME: &str = "logs";
const MAX_LOG_FILES: usize = 50;
const MAX_REPEAT_BLOCK_LINES: usize = 8;
const REPEAT_SUMMARY_FLUSH_THRESHOLD: u64 = 10_000;

struct RunLogger {
    inner: Mutex<LoggerInner>,
    run_id: String,
}

struct LoggerInner {
    file: File,
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

    let run_id = make_run_id();
    let file_name = format!("run-{}-{}.log", unix_ts_millis(), run_id);
    let file_path = logs_dir.join(file_name);

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file_path)
        .map_err(|e| format!("Failed creating log file {}: {e}", file_path.display()))?;

    let logger = RunLogger {
        inner: Mutex::new(LoggerInner {
            file,
            coalescer: RepeatCoalescer::new(),
        }),
        run_id,
    };

    if LOGGER.set(logger).is_err() {
        return Ok(());
    }

    prune_old_logs(&logs_dir, MAX_LOG_FILES);

    info(
        "logger",
        "initialized",
        &format!(
            "logs_dir={} max_files={}",
            logs_dir.display(),
            MAX_LOG_FILES
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
        if let Ok(mut inner) = logger.inner.lock() {
            let records = inner.coalescer.flush();
            write_log_records(&mut inner.file, &logger.run_id, records);
            if let Err(e) = inner.file.flush() {
                eprintln!("[midimaster-log-flush-failed] {e}");
            }
        }
    }
}

fn log(level: &str, component: &str, event: &str, details: &str) {
    let record = LogRecord::new(level, component, event, sanitize(details));

    if let Some(logger) = LOGGER.get() {
        if let Ok(mut inner) = logger.inner.lock() {
            let records = inner.coalescer.push(record.clone());
            write_log_records(&mut inner.file, &logger.run_id, records);
            return;
        }
    }

    let line = format_log_line(&record, "uninitialized");
    eprintln!("[midimaster-log-fallback] {}", line.trim_end());
}

fn write_log_records(file: &mut File, run_id: &str, records: Vec<LogRecord>) {
    for record in records {
        let line = format_log_line(&record, run_id);
        if let Err(e) = file.write_all(line.as_bytes()) {
            eprintln!(
                "[midimaster-log-write-failed] {e}; line={}",
                line.trim_end()
            );
        }
    }
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

fn sanitize(input: &str) -> String {
    input
        .replace(['\r', '\n', '\t'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
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

fn prune_old_logs(logs_dir: &Path, keep: usize) {
    let read_dir = match fs::read_dir(logs_dir) {
        Ok(dir) => dir,
        Err(_) => return,
    };

    let mut files: Vec<PathBuf> = read_dir
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("log"))
        .collect();

    files.sort_by(|a, b| {
        let a_name = a.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let b_name = b.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        b_name.cmp(a_name)
    });

    for path in files.into_iter().skip(keep) {
        let _ = fs::remove_file(path);
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
}
