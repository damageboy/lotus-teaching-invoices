package com.houmus.lotus_mobile

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.result.ActivityResult
import androidx.activity.result.IntentSenderRequest
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import java.io.File

@InvokeArg
class AuthorizeRequest {
    lateinit var scopes: Array<String>
    var interactive: Boolean = false
}

@InvokeArg
class AuthorizeArgs {
    lateinit var request: AuthorizeRequest
}

@InvokeArg
class ClearAccessTokenRequest {
    lateinit var accessToken: String
}

@InvokeArg
class ClearAccessTokenArgs {
    lateinit var request: ClearAccessTokenRequest
}

@InvokeArg
class OpenPdfArgs {
    lateinit var path: String
}

@TauriPlugin
class LotusMobilePlugin(
    private val activity: Activity,
) : Plugin(activity) {
    @Command
    fun authorize(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(AuthorizeArgs::class.java)
            val request =
                AuthorizationRequest
                    .builder()
                    .setRequestedScopes(args.request.scopes.map(::Scope))
                    .build()

            Identity
                .getAuthorizationClient(activity)
                .authorize(request)
                .addOnSuccessListener { result ->
                    when {
                        result.hasResolution() && !args.request.interactive -> {
                            invoke.resolve(JSObject().put("status", "needsUserAction"))
                        }

                        result.hasResolution() -> {
                            val intentSender = result.pendingIntent?.intentSender
                            if (intentSender == null) {
                                invoke.reject("Google authorization returned no resolution")
                            } else {
                                startIntentSenderForResult(
                                    invoke,
                                    IntentSenderRequest.Builder(intentSender).build(),
                                    "authorizationResult",
                                )
                            }
                        }

                        else -> {
                            resolveAuthorized(invoke, result)
                        }
                    }
                }.addOnFailureListener { error ->
                    invoke.reject(error.message ?: "Google authorization failed")
                }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Google authorization failed")
        }
    }

    @ActivityCallback
    fun authorizationResult(
        invoke: Invoke,
        result: ActivityResult,
    ) {
        if (result.resultCode == Activity.RESULT_CANCELED) {
            invoke.resolve(JSObject().put("status", "denied"))
            return
        }
        if (result.resultCode != Activity.RESULT_OK || result.data == null) {
            invoke.reject("Google authorization failed")
            return
        }

        try {
            val authorization =
                Identity
                    .getAuthorizationClient(activity)
                    .getAuthorizationResultFromIntent(result.data!!)
            resolveAuthorized(invoke, authorization)
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Google authorization failed")
        }
    }

    @Command
    fun clearAccessToken(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ClearAccessTokenArgs::class.java)
            val request =
                ClearTokenRequest
                    .builder()
                    .setToken(args.request.accessToken)
                    .build()
            Identity
                .getAuthorizationClient(activity)
                .clearToken(request)
                .addOnSuccessListener { invoke.resolve() }
                .addOnFailureListener { error ->
                    invoke.reject(error.message ?: "Could not clear Google access token")
                }
        } catch (error: Exception) {
            invoke.reject(error.message ?: "Could not clear Google access token")
        }
    }

    @Command
    fun openPdf(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(OpenPdfArgs::class.java)
            val cacheDirectory = File(activity.cacheDir, "invoice-pdfs").canonicalFile
            val pdf = File(args.path)
            val canonicalPdf = pdf.canonicalFile
            if (
                pdf.absoluteFile.path != canonicalPdf.path ||
                canonicalPdf.parentFile != cacheDirectory ||
                !canonicalPdf.name.endsWith(".pdf") ||
                canonicalPdf.name.contains("..") ||
                !canonicalPdf.isFile
            ) {
                invoke.reject("The PDF preview path is invalid")
                return
            }

            val uri =
                FileProvider.getUriForFile(
                    activity,
                    "${activity.packageName}.fileprovider",
                    canonicalPdf,
                )
            val intent =
                Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/pdf")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            activity.startActivity(intent)
            invoke.resolve(JSObject().put("status", "opened"))
        } catch (error: ActivityNotFoundException) {
            invoke.reject("No PDF viewer is installed")
        } catch (error: Exception) {
            invoke.reject(error.message ?: "The PDF could not be opened")
        }
    }

    private fun resolveAuthorized(
        invoke: Invoke,
        result: AuthorizationResult,
    ) {
        val accessToken = result.accessToken
        if (accessToken.isNullOrEmpty()) {
            invoke.reject("Google authorization returned no access token")
            return
        }

        invoke.resolve(
            JSObject()
                .put("status", "authorized")
                .put("accessToken", accessToken)
                .put("grantedScopes", JSArray.from(result.grantedScopes.toTypedArray())),
        )
    }
}
