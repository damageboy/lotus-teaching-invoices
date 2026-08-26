package com.houmus.teaching_invoices

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.util.Log
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import java.util.concurrent.TimeUnit

class ScopeProbeInstrumentation : Instrumentation() {
  override fun onStart() {
    super.onStart()
    Thread {
      try {
        val requestedScopes =
          listOf(
            "https://www.googleapis.com/auth/gmail.compose",
            "https://www.googleapis.com/auth/calendar.readonly",
            "https://www.googleapis.com/auth/calendar.events",
          )
        val request =
          AuthorizationRequest
            .builder()
            .setRequestedScopes(requestedScopes.map(::Scope))
            .build()
        val result =
          Tasks.await(
            Identity.getAuthorizationClient(targetContext).authorize(request),
            30,
            TimeUnit.SECONDS,
          )

        Log.i(
          "LotusAuthProbe",
          "hasResolution=${result.hasResolution()} grantedScopes=${result.grantedScopes.sorted()}",
        )
        finish(Activity.RESULT_OK, Bundle())
      } catch (error: Throwable) {
        Log.e("LotusAuthProbe", "probe failed", error)
        finish(
          Activity.RESULT_CANCELED,
          Bundle().apply {
            putString("error", error.toString())
          },
        )
      }
    }.start()
  }
}