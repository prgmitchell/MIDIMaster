use midimaster_virtual_audio_service as virtual_audio;
use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

#[cfg(windows)]
use std::time::Duration;
#[cfg(windows)]
use windows_service::define_windows_service;
#[cfg(windows)]
use windows_service::service::{
    ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState,
    ServiceStatus as WindowsServiceStatus, ServiceType,
};
#[cfg(windows)]
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
#[cfg(windows)]
use windows_service::service_dispatcher;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let mode = args.first().and_then(|arg| arg.to_str()).unwrap_or("");
    let result = match mode {
        "--self-test" => self_test(),
        "--version" => {
            println!(
                "MIDIMaster Virtual Audio {} VID:PID={}:{}",
                env!("CARGO_PKG_VERSION"),
                env!("MIDIMASTER_USB_VID"),
                env!("MIDIMASTER_USB_PID")
            );
            Ok(())
        }
        "--detach" => virtual_audio::attach::detach_own(),
        "--console" => run_console(),
        _ => run_as_service(),
    };
    if let Err(error) = result {
        eprintln!("MIDIMaster Virtual Audio: {error}");
        std::process::exit(1);
    }
}

fn self_test() -> Result<(), String> {
    let status = Arc::new(virtual_audio::status::ServiceStatus::default());
    let device = virtual_audio::create_device(status);
    device.descriptors.validate()?;
    let stop = Arc::new(AtomicBool::new(false));
    let server = virtual_audio::usbip::Server::bind(
        "127.0.0.1:0",
        device,
        Arc::new(virtual_audio::status::ServiceStatus::default()),
        stop,
    )
    .map_err(|error| error.to_string())?;
    if !server
        .local_addr()
        .map_err(|error| error.to_string())?
        .ip()
        .is_loopback()
    {
        return Err("self-test listener escaped loopback".into());
    }
    println!(
        "MIDIMaster Virtual Audio self-test passed (development_identity={})",
        virtual_audio::development_identity()
    );
    Ok(())
}

fn run_console() -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let handler_stop = stop.clone();
    ctrlc::set_handler(move || handler_stop.store(true, Ordering::Release))
        .map_err(|error| error.to_string())?;
    run_components(stop)
}

fn run_components(stop: Arc<AtomicBool>) -> Result<(), String> {
    let status = Arc::new(virtual_audio::status::ServiceStatus::default());
    let device = virtual_audio::create_device(status.clone());
    let server = virtual_audio::usbip::Server::bind(
        virtual_audio::USBIP_ADDRESS,
        device.clone(),
        status.clone(),
        stop.clone(),
    )
    .map_err(|error| format!("could not bind {}: {error}", virtual_audio::USBIP_ADDRESS))?;

    let attach_stop = stop.clone();
    let attach_status = status.clone();
    let attach = thread::spawn(move || {
        virtual_audio::attach::attachment_monitor(attach_stop, attach_status)
    });

    #[cfg(windows)]
    let audio_pipe = {
        let audio_stop = stop.clone();
        let audio_status = status.clone();
        let audio_device = device.clone();
        Some(thread::spawn(move || {
            virtual_audio::audio_pipe::serve_audio_pipe(audio_device, audio_status, audio_stop)
        }))
    };
    #[cfg(not(windows))]
    let audio_pipe: Option<thread::JoinHandle<()>> = None;

    #[cfg(windows)]
    let pipe = {
        let pipe_stop = stop.clone();
        let pipe_status = status.clone();
        Some(thread::spawn(move || {
            virtual_audio::status::serve_named_pipe(pipe_status, pipe_stop)
        }))
    };
    #[cfg(not(windows))]
    let pipe: Option<thread::JoinHandle<()>> = None;

    let result = server.serve().map_err(|error| error.to_string());
    stop.store(true, Ordering::Release);
    let _ = attach.join();
    if let Some(audio_pipe) = audio_pipe {
        let _ = audio_pipe.join();
    }
    if let Some(pipe) = pipe {
        let _ = pipe.join();
    }
    result
}

#[cfg(windows)]
define_windows_service!(ffi_service_main, service_main);

#[cfg(windows)]
fn run_as_service() -> Result<(), String> {
    service_dispatcher::start(virtual_audio::SERVICE_NAME, ffi_service_main)
        .map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn run_as_service() -> Result<(), String> {
    Err(
        "the MIDIMaster Virtual Audio service is Windows-only; use --self-test for portable checks"
            .into(),
    )
}

#[cfg(windows)]
fn service_main(_arguments: Vec<OsString>) {
    if let Err(error) = service_main_inner() {
        eprintln!("MIDIMaster Virtual Audio service failed: {error}");
    }
}

#[cfg(windows)]
fn service_main_inner() -> Result<(), String> {
    let stop = Arc::new(AtomicBool::new(false));
    let handler_stop = stop.clone();
    let status_handle =
        service_control_handler::register(virtual_audio::SERVICE_NAME, move |event| match event {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                handler_stop.store(true, Ordering::Release);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        })
        .map_err(|error| error.to_string())?;

    status_handle
        .set_service_status(windows_status(
            ServiceState::Running,
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            0,
            Duration::ZERO,
        ))
        .map_err(|error| error.to_string())?;
    let result = run_components(stop.clone());
    status_handle
        .set_service_status(windows_status(
            ServiceState::StopPending,
            ServiceControlAccept::empty(),
            1,
            Duration::from_secs(5),
        ))
        .map_err(|error| error.to_string())?;
    stop.store(true, Ordering::Release);
    let _ = virtual_audio::attach::detach_own();
    status_handle
        .set_service_status(windows_status(
            ServiceState::Stopped,
            ServiceControlAccept::empty(),
            0,
            Duration::ZERO,
        ))
        .map_err(|error| error.to_string())?;
    result
}

#[cfg(windows)]
fn windows_status(
    state: ServiceState,
    accepted: ServiceControlAccept,
    checkpoint: u32,
    wait_hint: Duration,
) -> WindowsServiceStatus {
    WindowsServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: accepted,
        exit_code: ServiceExitCode::Win32(0),
        checkpoint,
        wait_hint,
        process_id: None,
    }
}
