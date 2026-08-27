package com.houmus.teaching_invoices

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var backCheckInFlight = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (backCheckInFlight) return
          backCheckInFlight = true
          webView.evaluateJavascript(
            """
              (() => {
                const state = window.history.state;
                return state !== null
                  && typeof state === 'object'
                  && (Object.prototype.hasOwnProperty.call(state, 'lotusDriveFolderDialog')
                    || Object.prototype.hasOwnProperty.call(state, 'lotusSetupWizard'));
              })()
            """.trimIndent()
          ) { ownsSetupHistory ->
            if (ownsSetupHistory == "true") {
              webView.evaluateJavascript("window.history.back()") {
                backCheckInFlight = false
              }
              return@evaluateJavascript
            }

            backCheckInFlight = false
            isEnabled = false
            try {
              onBackPressedDispatcher.onBackPressed()
            } finally {
              isEnabled = true
            }
          }
        }
      }
    )
  }
}
