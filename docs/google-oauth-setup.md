# Google OAuth Setup

Use one Google Cloud project for the macOS desktop client and every Android client. The clients must authorize the same Google account for cross-device invoice checks.

## 1. Enable APIs

In **Google Cloud Console → APIs & Services → Library**, enable:

- Google Drive API
- Google Calendar API
- Gmail API

The app requests these exact scopes:

| Scope                                               | Use                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `https://www.googleapis.com/auth/gmail.compose`     | Create Gmail drafts.                                                                                |
| `https://www.googleapis.com/auth/calendar.readonly` | Read calendars and events.                                                                          |
| `https://www.googleapis.com/auth/calendar.events`   | Create and edit calendar events after the separate edit grant.                                      |
| `https://www.googleapis.com/auth/drive`             | Read and manage the selected My Drive or Shared Drive invoice tree, including manually copied PDFs. |

Do not substitute `drive.file`. It does not reliably cover PDFs copied into `Final` outside Lotus.

## 2. Configure the OAuth consent screen

Configure **Google Auth Platform → Branding, Audience, and Data Access** in the same project:

1. Set the production app name, support email, developer contact, homepage, and authorized domains.
2. Publish a privacy policy on a verified domain. It must describe the Calendar, Gmail, and Drive data the app accesses, how it uses that data, retention, sharing, and deletion/revocation behavior.
3. Declare every scope listed above. `drive` and `gmail.compose` are restricted scopes; the Calendar scopes also require the applicable sensitive-scope review.
4. Submit the production app for OAuth verification. Provide the homepage, privacy-policy link, scope justification, and the requested demonstration material. Complete any additional restricted-scope or security-assessment requirement Google assigns to the app's actual data handling.

Testing-mode users and internal Workspace exemptions are not production approval. Record verification status in the [release checklist](release/google-drive-invoice-storage-checklist.md).

## 3. Register the macOS desktop client

Create one OAuth 2.0 client with application type **Desktop app**. Lotus starts a listener on `127.0.0.1` using an available port and sends `http://127.0.0.1:<port>` as the loopback redirect URI.

Configure that desktop client ID and secret in `src/lib/gmail/constants.ts`. Do not use an Android or web client for the desktop loopback flow. The desktop app requests offline access and stores its Google refresh-token record only in the app's protected local storage.

## 4. Register Android clients

The Android package name is exactly:

```text
com.houmus.teaching_invoices
```

Create a separate **Android** OAuth 2.0 client for each certificate that can sign an installed build. Every client uses the package above and one SHA-1 fingerprint:

| Build          | SHA-1 source                                                                                                            | Record                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Debug          | `keytool -list -v -alias androiddebugkey -keystore "$HOME/.android/debug.keystore" -storepass android -keypass android` | `____________________________` |
| Direct release | `keytool -list -v -alias <alias> -keystore <release-keystore>`                                                          | `____________________________` |
| Google Play    | **Play Console → Setup → App integrity → App signing key certificate → SHA-1**                                          | `____________________________` |

Do not copy the upload-certificate SHA-1 into the Play row unless Play App Signing explicitly uses that same certificate. Debug, directly distributed release, and Play-signed APKs normally need distinct Android OAuth clients.

An Android OAuth client has no client secret to embed. Do not add the desktop client secret to Android resources, Kotlin, Gradle, or the APK. Android uses Google Identity Services `AuthorizationClient`, accepts a short-lived access token only after checking the granted scopes, and keeps no Lotus refresh-token record. On a later session the app asks `AuthorizationClient` again; user-facing consent is launched only from an explicit action when Google reports that resolution is required.

## 5. Keep cross-client Drive state visible

Lotus deliberately uses ordinary Drive storage:

- `lotus-invoices-config.yaml` is an ordinary, visible file directly inside the selected invoice root. It has the standard Drive property `lotusConfigSchema=1`; its one parent is the root.
- Managed PDFs use standard Drive `properties` such as `lotusSchema`, `lotusInvoiceNumber`, `lotusSourceSha256`, and `lotusPdfSha256`.

Never move the configuration file to `appDataFolder`. Only the application that created `appDataFolder` data can access it, and it is hidden from the Drive UI. Never replace standard `properties` with `appProperties`; `appProperties` are private to the requesting OAuth application. Either substitution would prevent the separate desktop and Android OAuth clients from sharing the same authority.

## Official references

- [OAuth 2.0 for installed apps and loopback redirects](https://developers.google.com/identity/protocols/oauth2/native-app)
- [OAuth 2.0 policies and production verification](https://developers.google.com/identity/protocols/oauth2/policies)
- [Configure OAuth consent](https://developers.google.com/workspace/guides/configure-oauth-consent)
- [Drive scopes and restricted-scope requirements](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Android user authorization](https://developer.android.com/identity/authorization)
- [Drive application-data folder](https://developers.google.com/workspace/drive/api/guides/appdata)
- [Drive custom properties](https://developers.google.com/workspace/drive/api/guides/properties)
