#[path = "support/pcm.rs"]
mod pcm;
#[path = "../../../scripts/perf/native_support.rs"]
mod support;
#[path = "support/usb_scheduler.rs"]
mod usb_scheduler;

fn main() {
    pcm::run();
    usb_scheduler::run();
}
