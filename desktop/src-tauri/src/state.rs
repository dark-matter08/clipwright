use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tokio::process::Child;

#[derive(Default)]
pub struct AppState {
    pub next_run_id: AtomicU32,
    pub runs: Mutex<HashMap<u32, tokio::sync::oneshot::Sender<()>>>,
    pub watchers: Mutex<HashMap<String, notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

impl AppState {
    pub fn next_id(&self) -> u32 {
        self.next_run_id.fetch_add(1, Ordering::SeqCst) + 1
    }
}

// Keep Child alive helper (unused but imported for future use)
#[allow(dead_code)]
pub type BoxChild = Box<Child>;
