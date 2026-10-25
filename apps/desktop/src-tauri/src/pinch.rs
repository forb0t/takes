//! A pinch on a trackpad zooms the diagram. On Linux WebKit would zoom the
//! whole window instead, so the gesture is taken from GTK first and passed
//! to the page as a "pinch" event: (zoom factor since the last one, x, y).

use tauri::WebviewWindow;

#[cfg(target_os = "linux")]
pub fn forward(window: &WebviewWindow) {
    use std::cell::Cell;
    use std::rc::Rc;

    use gtk::prelude::*;
    use tauri::Emitter;

    let target = window.clone();
    let _ = window.with_webview(move |platform| {
        let view = platform.inner();
        let gesture = gtk::GestureZoom::new(&view);
        // Before WebKit sees it, and claimed, so WebKit does not zoom.
        gesture.set_propagation_phase(gtk::PropagationPhase::Capture);
        let last = Rc::new(Cell::new(1.0_f64));
        {
            let last = last.clone();
            gesture.connect_begin(move |g, _| {
                last.set(1.0);
                g.set_state(gtk::EventSequenceState::Claimed);
            });
        }
        gesture.connect_scale_changed(move |g, scale| {
            if scale <= 0.0 {
                return;
            }
            let factor = scale / last.get();
            last.set(scale);
            let (x, y) = g.bounding_box_center().unwrap_or((0.0, 0.0));
            let _ = target.emit("pinch", (factor, x, y));
        });
        // The gesture lives as long as the view.
        unsafe { view.set_data("takes-pinch", gesture) };
    });
}

#[cfg(not(target_os = "linux"))]
pub fn forward(_window: &WebviewWindow) {
    // Elsewhere the web view sends a pinch to the page itself.
}
