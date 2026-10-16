package jp.co.keex.qprint

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // Android 13+ will not show a notification without this, and the foreground service's
    // notification is how the app is reopened once it has been put away.
    BackgroundService.requestPermission(this)
  }

  override fun onStart() {
    super.onStart()
    // Back in front: take the notification down, so it does not describe an app already in view.
    // Cheap and idempotent, and it covers returning through the notification's own Open button.
    BackgroundService.stop(this)
  }

  /**
   * Starts the foreground service when the user deliberately puts the app away, which is what keeps
   * it alive and puts the notification up.
   *
   * `onUserLeaveHint` rather than `onStop`, and the difference matters: `onStop` also fires whenever
   * another activity is put on top of this one — the Android print dialog included — which would pop
   * the background notification on every single print. `onUserLeaveHint` fires only when the user
   * leaves by their own hand: Home, the recents list, or Back out of the app.
   *
   * The service is what makes the notification worth having, so it starts here rather than on stop.
   * Swiping the app away from recents does not run this, which ends the app — that is a deliberate
   * exit, so the notification's Exit button is not needed for it.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    BackgroundService.start(this)
  }
}