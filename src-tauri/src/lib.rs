pub mod commands;
pub mod ffmpeg;
pub mod project;

use ffmpeg::export::ExportState;
use ffmpeg::proxy::ProxyQueue;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ExportState::default())
        .manage(ProxyQueue::default())
        .manage(commands::CapsCache::default())
        .invoke_handler(tauri::generate_handler![
            commands::detect_capabilities,
            commands::probe_media,
            commands::probe_music,
            commands::generate_proxy,
            commands::resolve_project,
            commands::plan_export,
            commands::start_export,
            commands::cancel_export,
            commands::save_project,
            commands::load_project,
            commands::proxy_cache_stats,
            commands::clear_proxy_cache,
            commands::missing_media,
            commands::proxy_concurrency,
        ])
        .run(tauri::generate_context!())
        .expect("error while running the application");
}
