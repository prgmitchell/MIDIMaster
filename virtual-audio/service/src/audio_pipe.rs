use crate::device::Device;
use crate::status::ServiceStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const AUDIO_PIPE_SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;IU)";

#[cfg(windows)]
struct LocalAudioPipeSecurity {
    descriptor: windows::Win32::Security::PSECURITY_DESCRIPTOR,
    attributes: windows::Win32::Security::SECURITY_ATTRIBUTES,
}

#[cfg(windows)]
impl LocalAudioPipeSecurity {
    fn new() -> windows::core::Result<Self> {
        use windows::core::PCWSTR;
        use windows::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
        };
        use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        let sddl = AUDIO_PIPE_SDDL
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut descriptor,
                None,
            )?;
        }
        Ok(Self {
            attributes: SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: false.into(),
            },
            descriptor,
        })
    }
}

#[cfg(windows)]
impl Drop for LocalAudioPipeSecurity {
    fn drop(&mut self) {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};

        if !self.descriptor.is_invalid() {
            unsafe {
                let _ = LocalFree(Some(HLOCAL(self.descriptor.0)));
            }
        }
    }
}

#[cfg(windows)]
pub fn serve_audio_pipe(device: Arc<Device>, status: Arc<ServiceStatus>, stop: Arc<AtomicBool>) {
    serve_audio_pipe_at(
        device,
        status,
        stop,
        midimaster_virtual_audio_protocol::AUDIO_PIPE_PATH,
    );
}

#[cfg(windows)]
pub fn serve_audio_pipe_at(
    device: Arc<Device>,
    status: Arc<ServiceStatus>,
    stop: Arc<AtomicBool>,
    path: &str,
) {
    use std::thread;
    use std::time::Duration;
    use windows::core::HRESULT;
    use windows::Win32::Foundation::{
        CloseHandle, ERROR_BROKEN_PIPE, ERROR_NO_DATA, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
        ERROR_PIPE_NOT_CONNECTED, INVALID_HANDLE_VALUE,
    };
    use windows::Win32::Storage::FileSystem::{ReadFile, PIPE_ACCESS_INBOUND};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, PIPE_NOWAIT, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
    };

    let security = match LocalAudioPipeSecurity::new() {
        Ok(security) => security,
        Err(error) => {
            status.set_error(format!("could not secure Virtual Audio PCM pipe: {error}"));
            return;
        }
    };

    while !stop.load(Ordering::Acquire) {
        let pipe = unsafe {
            CreateNamedPipeW(
                &windows::core::HSTRING::from(path),
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS | PIPE_NOWAIT,
                1,
                0,
                64 * 1024,
                0,
                Some(&security.attributes),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            status.set_error("could not create Virtual Audio PCM pipe");
            thread::sleep(Duration::from_secs(1));
            continue;
        }

        let connected = loop {
            if stop.load(Ordering::Acquire) {
                break false;
            }
            match unsafe { ConnectNamedPipe(pipe, None) } {
                Ok(()) => break true,
                Err(error) if error.code() == HRESULT::from_win32(ERROR_PIPE_CONNECTED.0) => {
                    break true;
                }
                Err(error) if error.code() == HRESULT::from_win32(ERROR_PIPE_LISTENING.0) => {
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => {
                    status.set_error(format!("could not accept Virtual Audio PCM pipe: {error}"));
                    break false;
                }
            }
        };

        if connected {
            let mut buffer = [0u8; 64 * 1024];
            while !stop.load(Ordering::Acquire) {
                let mut read = 0u32;
                match unsafe { ReadFile(pipe, Some(&mut buffer), Some(&mut read), None) } {
                    Ok(()) if read > 0 => {
                        device.write_router_audio(&buffer[..read as usize]);
                    }
                    Ok(()) => thread::sleep(Duration::from_millis(2)),
                    Err(error)
                        if error.code() == HRESULT::from_win32(ERROR_NO_DATA.0)
                            || error.code() == HRESULT::from_win32(ERROR_PIPE_LISTENING.0) =>
                    {
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error)
                        if error.code() == HRESULT::from_win32(ERROR_BROKEN_PIPE.0)
                            || error.code() == HRESULT::from_win32(ERROR_PIPE_NOT_CONNECTED.0) =>
                    {
                        break;
                    }
                    Err(error) => {
                        status.set_error(format!("Virtual Audio PCM pipe failed: {error}"));
                        break;
                    }
                }
            }
        }

        unsafe {
            let _ = CloseHandle(pipe);
        }
    }
}
