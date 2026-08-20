// USB/IP 1.1.1 server, derived from Virtual Cables' BSD-licensed user-space
// implementation. This listener is intentionally fixed to localhost by main.

use crate::device::{Device, STATUS_OK, STATUS_PIPE};
use crate::status::ServiceStatus;
use crate::uac1::SetupPacket;
use std::collections::HashMap;
use std::io::{self, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: u16 = 0x0111;
const OP_REQ_IMPORT: u16 = 0x8003;
const OP_REP_IMPORT: u16 = 0x0003;
const OP_REQ_DEVLIST: u16 = 0x8005;
const OP_REP_DEVLIST: u16 = 0x0005;
const CMD_SUBMIT: u32 = 1;
const CMD_UNLINK: u32 = 2;
const RET_SUBMIT: u32 = 3;
const RET_UNLINK: u32 = 4;
const DIRECTION_OUT: u32 = 0;
const DIRECTION_IN: u32 = 1;
const NO_ISO_PACKETS: u32 = 0xffff_ffff;
const MAX_TRANSFER_LENGTH: u32 = 16 * 1024 * 1024;
const MAX_ISO_PACKETS: u32 = 4096;
const MAX_CONNECTIONS: usize = 8;
const MAX_PENDING_URBS: usize = 128;
const STATUS_CONNECTION_RESET: i32 = -104;

#[derive(Debug, Clone, Copy)]
struct BasicHeader {
    command: u32,
    sequence: u32,
    _device_id: u32,
    direction: u32,
    endpoint: u32,
}

#[derive(Debug, Clone)]
struct SubmitRequest {
    basic: BasicHeader,
    _transfer_flags: u32,
    transfer_buffer_length: u32,
    start_frame: u32,
    number_of_packets: u32,
    _interval: u32,
    setup: [u8; 8],
}

impl SubmitRequest {
    fn is_isochronous(&self) -> bool {
        self.number_of_packets != 0 && self.number_of_packets != NO_ISO_PACKETS
    }
}

#[derive(Debug, Clone, Copy)]
struct IsoPacket {
    offset: u32,
    length: u32,
    actual_length: u32,
    status: i32,
}

#[derive(Debug)]
struct ParsedSubmit {
    request: SubmitRequest,
    output: Vec<u8>,
    packets: Vec<IsoPacket>,
    complete_at: Option<Instant>,
}

#[derive(Debug)]
struct ConnectionState {
    writer: Mutex<TcpStream>,
    pending: Mutex<HashMap<u32, Arc<AtomicBool>>>,
    iso_next: Mutex<HashMap<u32, Instant>>,
}

impl ConnectionState {
    fn new(writer: TcpStream) -> Self {
        Self {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            iso_next: Mutex::new(HashMap::new()),
        }
    }

    fn reserve_iso(&self, endpoint: u32, packets: u32) -> Instant {
        let now = Instant::now();
        let duration = Duration::from_millis(u64::from(packets).min(250));
        let mut timelines = self.iso_next.lock().expect("iso timeline poisoned");
        let previous = timelines.get(&endpoint).copied().unwrap_or(now);
        // Refuse an unbounded host queue: stale or >500 ms future timelines restart now.
        let base = if previous < now || previous.duration_since(now) > Duration::from_millis(500) {
            now
        } else {
            previous
        };
        let deadline = base + duration;
        timelines.insert(endpoint, deadline);
        deadline
    }

    fn add_pending(&self, sequence: u32, cancelled: Arc<AtomicBool>) -> io::Result<()> {
        let mut pending = self.pending.lock().expect("pending map poisoned");
        if pending.len() >= MAX_PENDING_URBS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "too many pending USB/IP URBs",
            ));
        }
        if let Some(previous) = pending.insert(sequence, cancelled) {
            previous.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn remove_pending(&self, sequence: u32) {
        self.pending
            .lock()
            .expect("pending map poisoned")
            .remove(&sequence);
    }

    fn cancel(&self, sequence: u32) -> bool {
        let pending = self.pending.lock().expect("pending map poisoned");
        match pending.get(&sequence) {
            Some(cancelled) => {
                cancelled.store(true, Ordering::Release);
                true
            }
            None => false,
        }
    }

    fn cancel_all(&self) {
        for cancelled in self.pending.lock().expect("pending map poisoned").values() {
            cancelled.store(true, Ordering::Release);
        }
    }

    fn write_submit(
        &self,
        request: &SubmitRequest,
        status: i32,
        actual: u32,
        data: &[u8],
        packets: &[IsoPacket],
        errors: u32,
    ) -> io::Result<()> {
        let frame = ret_submit_frame(request, status, actual, data, packets, errors);
        self.writer
            .lock()
            .expect("USB/IP writer poisoned")
            .write_all(&frame)
    }

    fn write_unlink(&self, request: BasicHeader, status: i32) -> io::Result<()> {
        let mut frame = Vec::with_capacity(48);
        put_u32(&mut frame, RET_UNLINK);
        put_u32(&mut frame, request.sequence);
        frame.extend_from_slice(&[0; 12]);
        put_i32(&mut frame, status);
        frame.extend_from_slice(&[0; 24]);
        self.writer
            .lock()
            .expect("USB/IP writer poisoned")
            .write_all(&frame)
    }
}

#[derive(Debug)]
pub struct Server {
    listener: TcpListener,
    device: Arc<Device>,
    status: Arc<ServiceStatus>,
    stop: Arc<AtomicBool>,
    connections: Arc<AtomicUsize>,
    handshake_timeout: Duration,
}

impl Server {
    pub fn bind(
        address: &str,
        device: Arc<Device>,
        status: Arc<ServiceStatus>,
        stop: Arc<AtomicBool>,
    ) -> io::Result<Self> {
        Self::bind_with_handshake_timeout(address, device, status, stop, Duration::from_secs(30))
    }

    fn bind_with_handshake_timeout(
        address: &str,
        device: Arc<Device>,
        status: Arc<ServiceStatus>,
        stop: Arc<AtomicBool>,
        handshake_timeout: Duration,
    ) -> io::Result<Self> {
        let parsed: SocketAddr = address.parse().map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "invalid USB/IP listen address")
        })?;
        if !parsed.ip().is_loopback() {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "USB/IP must bind to loopback only",
            ));
        }
        let listener = TcpListener::bind(parsed)?;
        listener.set_nonblocking(true)?;
        Ok(Self {
            listener,
            device,
            status,
            stop,
            connections: Arc::new(AtomicUsize::new(0)),
            handshake_timeout,
        })
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }

    pub fn serve(self) -> io::Result<()> {
        self.status.set_running(true);
        while !self.stop.load(Ordering::Acquire) {
            match self.listener.accept() {
                Ok((stream, remote)) => {
                    if !remote.ip().is_loopback()
                        || self.connections.fetch_add(1, Ordering::AcqRel) >= MAX_CONNECTIONS
                    {
                        self.connections.fetch_sub(1, Ordering::AcqRel);
                        drop(stream);
                        continue;
                    }
                    let device = self.device.clone();
                    let status = self.status.clone();
                    let count = self.connections.clone();
                    let handshake_timeout = self.handshake_timeout;
                    thread::spawn(move || {
                        status.session_opened();
                        if let Err(error) =
                            handle_connection(stream, device, status.clone(), handshake_timeout)
                        {
                            // A management probe or one USB/IP socket ending does
                            // not detach the Windows port. The attachment monitor
                            // owns port health and will observe the authoritative
                            // `usbip port` state without disrupting another active
                            // session.
                            if error.kind() != io::ErrorKind::UnexpectedEof
                                && error.kind() != io::ErrorKind::ConnectionReset
                            {
                                status.set_error(format!("USB/IP session: {error}"));
                            }
                        }
                        status.session_closed();
                        count.fetch_sub(1, Ordering::AcqRel);
                    });
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25))
                }
                Err(error) => {
                    self.status.set_running(false);
                    return Err(error);
                }
            }
        }
        self.status.set_running(false);
        Ok(())
    }
}

fn handle_connection(
    stream: TcpStream,
    device: Arc<Device>,
    status: Arc<ServiceStatus>,
    handshake_timeout: Duration,
) -> io::Result<()> {
    // The listener must be non-blocking so the service can observe shutdown,
    // but Winsock propagates that mode to accepted sockets. USB/IP sessions
    // are handled on dedicated threads and require blocking reads; otherwise
    // the first gap between IMPORT and an URB fails with WSAEWOULDBLOCK 10035.
    stream.set_nonblocking(false)?;
    stream.set_nodelay(true)?;
    stream.set_read_timeout(Some(handshake_timeout))?;
    let mut reader = BufReader::with_capacity(64 * 1024, stream.try_clone()?);
    let version = read_u16(&mut reader)?;
    let opcode = read_u16(&mut reader)?;
    let _management_status = read_u32(&mut reader)?;
    if version != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported USB/IP version {version:#06x}"),
        ));
    }
    match opcode {
        OP_REQ_DEVLIST => write_device_list(stream, &device),
        OP_REQ_IMPORT => {
            let mut raw_bus = [0u8; 32];
            reader.read_exact(&mut raw_bus)?;
            let end = raw_bus
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(raw_bus.len());
            if &raw_bus[..end] != device.bus_id.as_bytes() {
                let mut writer = stream;
                write_op_header(&mut writer, OP_REP_IMPORT, 1)?;
                return Ok(());
            }
            let mut writer = stream.try_clone()?;
            write_op_header(&mut writer, OP_REP_IMPORT, 0)?;
            write_usb_device(&mut writer, &device)?;
            // `reader` owns a cloned Winsock handle. Socket options applied to
            // `stream` after `try_clone` do not reliably update that handle on
            // Windows, so clear the handshake timeout on the reader itself.
            reader.get_ref().set_read_timeout(None)?;
            handle_urbs(reader, stream, device, status)
        }
        _ => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unsupported USB/IP opcode {opcode:#06x}"),
        )),
    }
}

fn write_device_list(mut writer: TcpStream, device: &Device) -> io::Result<()> {
    write_op_header(&mut writer, OP_REP_DEVLIST, 0)?;
    put_write_u32(&mut writer, 1)?;
    write_usb_device(&mut writer, device)?;
    writer.write_all(&[0x01, 0x01, 0x00, 0, 0x01, 0x02, 0x00, 0])
}

fn write_usb_device(writer: &mut impl Write, device: &Device) -> io::Result<()> {
    write_fixed(
        writer,
        &format!("/sys/devices/platform/midimaster/{}", device.bus_id),
        256,
    )?;
    write_fixed(writer, device.bus_id, 32)?;
    let descriptor = &device.descriptors.device;
    for value in [1u32, 1, 2] {
        put_write_u32(writer, value)?;
    }
    for value in [
        u16::from_le_bytes([descriptor[8], descriptor[9]]),
        u16::from_le_bytes([descriptor[10], descriptor[11]]),
        u16::from_le_bytes([descriptor[12], descriptor[13]]),
    ] {
        put_write_u16(writer, value)?;
    }
    writer.write_all(&[
        descriptor[4],
        descriptor[5],
        descriptor[6],
        1,
        descriptor[17],
        device.descriptors.configuration[4],
    ])
}

fn handle_urbs(
    mut reader: BufReader<TcpStream>,
    writer: TcpStream,
    device: Arc<Device>,
    _status: Arc<ServiceStatus>,
) -> io::Result<()> {
    let state = Arc::new(ConnectionState::new(writer));
    let result = loop {
        let basic = match read_basic(&mut reader) {
            Ok(value) => value,
            Err(error) => break Err(error),
        };
        match basic.command {
            CMD_SUBMIT => {
                let mut submit = read_submit(&mut reader, basic)?;
                if basic.endpoint == 0 || !submit.request.is_isochronous() {
                    process_submit(&state, &device, submit, None)?;
                } else {
                    let cancelled = Arc::new(AtomicBool::new(false));
                    submit.complete_at =
                        Some(state.reserve_iso(basic.endpoint, submit.request.number_of_packets));
                    state.add_pending(basic.sequence, cancelled.clone())?;
                    let worker_state = state.clone();
                    let worker_device = device.clone();
                    thread::spawn(move || {
                        let _ =
                            process_submit(&worker_state, &worker_device, submit, Some(cancelled));
                        worker_state.remove_pending(basic.sequence);
                    });
                }
            }
            CMD_UNLINK => {
                let target = read_u32(&mut reader)?;
                let mut reserved = [0u8; 24];
                reader.read_exact(&mut reserved)?;
                let status = if state.cancel(target) {
                    STATUS_CONNECTION_RESET
                } else {
                    STATUS_OK
                };
                state.write_unlink(basic, status)?;
            }
            command => {
                break Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("unsupported USB/IP command {command:#010x}"),
                ))
            }
        }
    };
    state.cancel_all();
    result
}

fn process_submit(
    state: &ConnectionState,
    device: &Device,
    mut submit: ParsedSubmit,
    cancelled: Option<Arc<AtomicBool>>,
) -> io::Result<()> {
    let request = &submit.request;
    if request.basic.endpoint == 0 {
        let (mut data, status) =
            device.handle_control(SetupPacket::parse(request.setup), &submit.output);
        data.truncate(request.transfer_buffer_length as usize);
        let (actual, returned) = if request.basic.direction == DIRECTION_OUT && status == STATUS_OK
        {
            (submit.output.len() as u32, &[][..])
        } else {
            (data.len() as u32, data.as_slice())
        };
        return state.write_submit(request, status, actual, returned, &[], 0);
    }

    if wait_until(submit.complete_at, cancelled.as_deref()).is_err() {
        mark_iso_error(&mut submit.packets, STATUS_CONNECTION_RESET);
        return state.write_submit(
            request,
            STATUS_CONNECTION_RESET,
            0,
            &[],
            &submit.packets,
            submit.packets.len() as u32,
        );
    }
    match (request.basic.endpoint, request.basic.direction) {
        (2, DIRECTION_IN) => {
            let length = response_payload_length(request, &submit.packets);
            let mut data = vec![0; length];
            device.read_capture(&mut data);
            mark_iso_packets(&mut submit.packets, length);
            state.write_submit(request, STATUS_OK, length as u32, &data, &submit.packets, 0)
        }
        _ => {
            mark_iso_error(&mut submit.packets, STATUS_PIPE);
            state.write_submit(
                request,
                STATUS_PIPE,
                0,
                &[],
                &submit.packets,
                submit.packets.len() as u32,
            )
        }
    }
}

fn wait_until(deadline: Option<Instant>, cancelled: Option<&AtomicBool>) -> Result<(), ()> {
    let Some(deadline) = deadline else {
        return Ok(());
    };
    loop {
        if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            return Err(());
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(());
        }
        thread::sleep((deadline - now).min(Duration::from_millis(2)));
    }
}

fn read_submit(reader: &mut impl Read, basic: BasicHeader) -> io::Result<ParsedSubmit> {
    let request = SubmitRequest {
        basic,
        _transfer_flags: read_u32(reader)?,
        transfer_buffer_length: read_u32(reader)?,
        start_frame: read_u32(reader)?,
        number_of_packets: read_u32(reader)?,
        _interval: read_u32(reader)?,
        setup: {
            let mut value = [0; 8];
            reader.read_exact(&mut value)?;
            value
        },
    };
    if request.transfer_buffer_length > MAX_TRANSFER_LENGTH {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "USB/IP transfer exceeds 16 MiB",
        ));
    }
    let mut output = vec![];
    if basic.direction == DIRECTION_OUT && request.transfer_buffer_length > 0 {
        output.resize(request.transfer_buffer_length as usize, 0);
        reader.read_exact(&mut output)?;
    }
    let mut packets = vec![];
    if request.number_of_packets != 0 && request.number_of_packets != NO_ISO_PACKETS {
        if request.number_of_packets > MAX_ISO_PACKETS {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "too many isochronous packets",
            ));
        }
        for _ in 0..request.number_of_packets {
            packets.push(IsoPacket {
                offset: read_u32(reader)?,
                length: read_u32(reader)?,
                actual_length: read_u32(reader)?,
                status: read_i32(reader)?,
            });
        }
    }
    Ok(ParsedSubmit {
        request,
        output,
        packets,
        complete_at: None,
    })
}

fn response_payload_length(request: &SubmitRequest, packets: &[IsoPacket]) -> usize {
    if packets.is_empty() {
        return request.transfer_buffer_length as usize;
    }
    let total: u64 = packets.iter().map(|packet| u64::from(packet.length)).sum();
    total
        .min(u64::from(request.transfer_buffer_length))
        .min(u64::from(MAX_TRANSFER_LENGTH)) as usize
}

fn mark_iso_packets(packets: &mut [IsoPacket], actual: usize) {
    let mut remaining = actual;
    for packet in packets {
        let length = (packet.length as usize).min(remaining);
        packet.actual_length = length as u32;
        packet.status = STATUS_OK;
        remaining -= length;
    }
}

fn mark_iso_error(packets: &mut [IsoPacket], status: i32) {
    for packet in packets {
        packet.actual_length = 0;
        packet.status = status;
    }
}

fn ret_submit_frame(
    request: &SubmitRequest,
    status: i32,
    mut actual: u32,
    mut data: &[u8],
    packets: &[IsoPacket],
    errors: u32,
) -> Vec<u8> {
    if status != STATUS_OK {
        actual = 0;
        data = &[];
    }
    let is_iso = request.is_isochronous();
    let mut frame = Vec::with_capacity(48 + data.len() + packets.len() * 16);
    put_u32(&mut frame, RET_SUBMIT);
    put_u32(&mut frame, request.basic.sequence);
    frame.extend_from_slice(&[0; 12]);
    put_i32(&mut frame, status);
    put_u32(&mut frame, actual);
    put_u32(&mut frame, if is_iso { request.start_frame } else { 0 });
    put_u32(
        &mut frame,
        if is_iso {
            packets.len() as u32
        } else {
            NO_ISO_PACKETS
        },
    );
    put_u32(&mut frame, errors);
    frame.extend_from_slice(&[0; 8]);
    frame.extend_from_slice(data);
    for packet in packets {
        put_u32(&mut frame, packet.offset);
        put_u32(&mut frame, packet.length);
        put_u32(&mut frame, packet.actual_length);
        put_i32(&mut frame, packet.status);
    }
    frame
}

fn read_basic(reader: &mut impl Read) -> io::Result<BasicHeader> {
    Ok(BasicHeader {
        command: read_u32(reader)?,
        sequence: read_u32(reader)?,
        _device_id: read_u32(reader)?,
        direction: read_u32(reader)?,
        endpoint: read_u32(reader)?,
    })
}
fn write_op_header(writer: &mut impl Write, code: u16, status: u32) -> io::Result<()> {
    put_write_u16(writer, PROTOCOL_VERSION)?;
    put_write_u16(writer, code)?;
    put_write_u32(writer, status)
}
fn write_fixed(writer: &mut impl Write, value: &str, length: usize) -> io::Result<()> {
    let mut bytes = vec![0; length];
    let copy = value.as_bytes().len().min(length);
    bytes[..copy].copy_from_slice(&value.as_bytes()[..copy]);
    writer.write_all(&bytes)
}
fn read_u16(reader: &mut impl Read) -> io::Result<u16> {
    let mut b = [0; 2];
    reader.read_exact(&mut b)?;
    Ok(u16::from_be_bytes(b))
}
fn read_u32(reader: &mut impl Read) -> io::Result<u32> {
    let mut b = [0; 4];
    reader.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}
fn read_i32(reader: &mut impl Read) -> io::Result<i32> {
    Ok(read_u32(reader)? as i32)
}
fn put_write_u16(writer: &mut impl Write, value: u16) -> io::Result<()> {
    writer.write_all(&value.to_be_bytes())
}
fn put_write_u32(writer: &mut impl Write, value: u32) -> io::Result<()> {
    writer.write_all(&value.to_be_bytes())
}
fn put_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_be_bytes());
}
fn put_i32(output: &mut Vec<u8>, value: i32) {
    output.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_server() -> (
        SocketAddr,
        Arc<AtomicBool>,
        thread::JoinHandle<io::Result<()>>,
    ) {
        let status = Arc::new(ServiceStatus::default());
        let device = Arc::new(Device::new(0x1209, 0x4321, status.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let server = Server::bind("127.0.0.1:0", device, status, stop.clone()).unwrap();
        let address = server.local_addr().unwrap();
        let handle = thread::spawn(move || server.serve());
        (address, stop, handle)
    }

    fn test_server_with_timeout(
        handshake_timeout: Duration,
    ) -> (
        SocketAddr,
        Arc<AtomicBool>,
        thread::JoinHandle<io::Result<()>>,
    ) {
        let status = Arc::new(ServiceStatus::default());
        let device = Arc::new(Device::new(0x1209, 0x4321, status.clone()));
        let stop = Arc::new(AtomicBool::new(false));
        let server = Server::bind_with_handshake_timeout(
            "127.0.0.1:0",
            device,
            status,
            stop.clone(),
            handshake_timeout,
        )
        .unwrap();
        let address = server.local_addr().unwrap();
        let handle = thread::spawn(move || server.serve());
        (address, stop, handle)
    }

    #[test]
    fn reply_zeroes_fields_that_usbip_requires_zero() {
        let request = SubmitRequest {
            basic: BasicHeader {
                command: CMD_SUBMIT,
                sequence: 42,
                _device_id: 7,
                direction: DIRECTION_IN,
                endpoint: 2,
            },
            _transfer_flags: 0,
            transfer_buffer_length: 4,
            start_frame: 0,
            number_of_packets: NO_ISO_PACKETS,
            _interval: 0,
            setup: [0; 8],
        };
        let frame = ret_submit_frame(&request, STATUS_OK, 4, &[1, 2, 3, 4], &[], 0);
        assert_eq!(&frame[..8], &[0, 0, 0, 3, 0, 0, 0, 42]);
        assert_eq!(&frame[8..20], &[0; 12]);
        assert_eq!(&frame[48..], &[1, 2, 3, 4]);
    }

    #[test]
    fn rejects_excessive_transfer_before_allocating() {
        let mut wire = Vec::new();
        for value in [0, MAX_TRANSFER_LENGTH + 1, 0, NO_ISO_PACKETS, 0] {
            put_u32(&mut wire, value);
        }
        wire.extend_from_slice(&[0; 8]);
        let header = BasicHeader {
            command: CMD_SUBMIT,
            sequence: 1,
            _device_id: 0,
            direction: DIRECTION_IN,
            endpoint: 2,
        };
        assert_eq!(
            read_submit(&mut wire.as_slice(), header)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
    }

    #[test]
    fn server_refuses_non_loopback_bind() {
        let status = Arc::new(ServiceStatus::default());
        let device = Arc::new(Device::new(0xffff, 0xca01, status.clone()));
        let result = Server::bind(
            "0.0.0.0:0",
            device,
            status,
            Arc::new(AtomicBool::new(false)),
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn device_list_handshake_advertises_one_uac1_device() {
        let (address, stop, handle) = test_server();
        let mut client = TcpStream::connect(address).unwrap();
        write_op_header(&mut client, OP_REQ_DEVLIST, 0).unwrap();
        let mut reply = vec![0u8; 8 + 4 + 312 + 8];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(u16::from_be_bytes([reply[0], reply[1]]), PROTOCOL_VERSION);
        assert_eq!(u16::from_be_bytes([reply[2], reply[3]]), OP_REP_DEVLIST);
        assert_eq!(u32::from_be_bytes(reply[8..12].try_into().unwrap()), 1);
        let bus_offset = 8 + 4 + 256;
        assert_eq!(&reply[bus_offset..bus_offset + 3], b"1-1");
        let identity_offset = bus_offset + 32 + 12;
        assert_eq!(
            u16::from_be_bytes(
                reply[identity_offset..identity_offset + 2]
                    .try_into()
                    .unwrap()
            ),
            0x1209
        );
        assert_eq!(
            u16::from_be_bytes(
                reply[identity_offset + 2..identity_offset + 4]
                    .try_into()
                    .unwrap()
            ),
            0x4321
        );
        drop(client);
        stop.store(true, Ordering::Release);
        handle.join().unwrap().unwrap();
    }

    #[test]
    fn imported_session_waits_for_delayed_urb() {
        let (address, stop, handle) = test_server_with_timeout(Duration::from_millis(50));
        let mut client = TcpStream::connect(address).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();

        write_op_header(&mut client, OP_REQ_IMPORT, 0).unwrap();
        write_fixed(&mut client, "1-1", 32).unwrap();
        let mut import_reply = vec![0u8; 8 + 312];
        client.read_exact(&mut import_reply).unwrap();
        assert_eq!(
            u16::from_be_bytes([import_reply[2], import_reply[3]]),
            OP_REP_IMPORT
        );

        // usbip-win2 does not necessarily submit the first URB in the same
        // packet as IMPORT. This delay reproduces the real Windows failure.
        thread::sleep(Duration::from_millis(100));
        let mut request = Vec::with_capacity(48);
        for value in [
            CMD_SUBMIT,
            1,
            0,
            DIRECTION_IN,
            0,
            0,
            0,
            0,
            NO_ISO_PACKETS,
            0,
        ] {
            put_u32(&mut request, value);
        }
        request.extend_from_slice(&[0; 8]);
        client.write_all(&request).unwrap();

        let mut reply = [0u8; 48];
        client.read_exact(&mut reply).unwrap();
        assert_eq!(
            u32::from_be_bytes(reply[..4].try_into().unwrap()),
            RET_SUBMIT
        );

        drop(client);
        stop.store(true, Ordering::Release);
        handle.join().unwrap().unwrap();
    }
}
