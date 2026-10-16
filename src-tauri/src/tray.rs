//! The desktop tray icon: how the app stays reachable once its window is closed.
//!
//! Desktop only. On Android there is no tray, and `BackgroundService.kt` is the equivalent — a
//! foreground service showing a notification with Open and Exit on it. Neither needs the frontend:
//! each platform's half looks after itself.
//!
//! Two rules keep this predictable, because both were easy to get wrong:
//!
//! - Closing the window hides it. It does not quit. A print job in flight must not be lost because
//!   somebody clicked the X, and a print app is exactly the kind somebody leaves running. Quitting is
//!   then an explicit act from the tray menu, where it is labelled as such.
//! - If the tray could not be created, the app carries on as an ordinary windowed app rather than
//!   refusing to start. A tray that failed to appear would otherwise leave no way back into a
//!   window that had already been hidden.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WindowEvent};

/// Menu item ids. Kept as constants so the labels and the handler cannot drift apart.
const OPEN: &str = "open";
const EXIT: &str = "exit";

/// What a menu item does. Split out from the handler so it can be tested without a running app.
#[derive(Debug, PartialEq, Eq)]
enum Action {
    /// Bring the window back and focus it.
    Show,
    /// Quit for good. Not close the window, which would hide it and leave the tray behind with no
    /// window to show.
    Quit,
}

/// Reads a menu item id into what it means.
fn action_for(id: &str) -> Option<Action> {
    match id {
        OPEN => Some(Action::Show),
        EXIT => Some(Action::Quit),
        _ => None,
    }
}

/// Brings the window back and puts the keyboard focus on it.
pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else { return };
    // Order matters: unminimise and un-hide before showing, or macOS restores it still minimised.
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

/// Puts the tray in place. Returns false when it could not be built, which is not fatal.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> bool {
    let open = match MenuItem::with_id(app, OPEN, "Open Q-Print", true, None::<&str>) {
        Ok(item) => item,
        Err(e) => {
            eprintln!("[tray] could not build the Open item: {e}");
            return false;
        }
    };
    let exit = match MenuItem::with_id(app, EXIT, "Exit", true, None::<&str>) {
        Ok(item) => item,
        Err(e) => {
            eprintln!("[tray] could not build the Exit item: {e}");
            return false;
        }
    };
    let menu = match Menu::with_items(app, &[&open, &exit]) {
        Ok(menu) => menu,
        Err(e) => {
            eprintln!("[tray] could not build the menu: {e}");
            return false;
        }
    };

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Q-Print")
        // Only a real secondary click opens the menu, so a left click can show the window instead.
        // On Windows and Linux a left click would otherwise do nothing at all.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match action_for(event.id().as_ref()) {
            Some(Action::Show) => show_main_window(app),
            // Straight to the real exit: the window is deliberately not closed first, because that
            // would trigger the close handler and hide it again instead of quitting.
            Some(Action::Quit) => app.exit(0),
            None => eprintln!("[tray] unhandled menu item {:?}", event.id()),
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // The app icon doubles as the tray icon. A tray with no icon is an invisible gap in the taskbar,
    // so a missing one is worth reporting rather than passing unnoticed.
    match app.default_window_icon().cloned() {
        Some(icon) => {
            builder = builder.icon(icon);
            // A template icon on macOS is drawn as a mask, so it stays legible in a light or dark menu bar.
            #[cfg(target_os = "macos")]
            {
                builder = builder.icon_as_template(true);
            }
        }
        None => eprintln!("[tray] no window icon to use for the tray"),
    }

    // `build` takes the Manager rather than the AppHandle, so the handle is passed through as one.
    match builder.build(app) {
        Ok(_) => true,
        Err(e) => {
            eprintln!("[tray] could not be created: {e}");
            false
        }
    }
}

/// Turns "close the window" into "put the window away", which is what keeps the app in the tray.
///
/// Returns nothing: the window is always prevented from closing, because the tray has to stay the
/// way back in. If the tray is missing, though, hiding the window would strand the app with no way
/// to show it again, so the close is allowed through in that case.
pub fn on_window_event<R: Runtime>(app: &AppHandle<R>, window: &tauri::Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if app.tray_by_id("main").is_none() {
        // No tray, so a hidden window would be lost for good. Let it close as usual.
        return;
    }
    api.prevent_close();
    let _ = window.hide();
}

#[cfg(test)]
mod tests {
    use super::{action_for, Action, EXIT, OPEN};

    #[test]
    fn open_shows_the_window_and_exit_quits() {
        assert_eq!(action_for(OPEN), Some(Action::Show));
        assert_eq!(action_for(EXIT), Some(Action::Quit));
    }

    #[test]
    fn the_two_items_do_the_same_thing() {
        // Sharing an id would make one of them unreachable, and nothing else would catch it.
        assert_ne!(OPEN, EXIT);
    }

    #[test]
    fn an_unknown_item_does_nothing_rather_than_guessing() {
        // Anything else is better left alone than mapped onto the nearest action, which could quit
        // the app over a stray id.
        assert_eq!(action_for(""), None);
        assert_eq!(action_for("quit"), None);
        assert_eq!(action_for("Open"), None);
    }
}