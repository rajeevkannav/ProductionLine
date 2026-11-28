---
name: hotwire-native-mobile
description: Enforces Hotwire Native Android (Kotlin/Gradle .apk) and iOS (SwiftPM/Xcode) architecture, path configurations, and Bearer token session sync against the live Rails backend.
---

# Hotwire Native Mobile Contract

1. **Rails Backend Endpoints:**
   - Serve `/configurations/ios_v1.json` and `/configurations/android_v1.json` with valid Hotwire Native path rules (modals for `/session/new`, `/registration/new`, `/accounts/new`, `/sudo`).
   - Support Bearer `ApiToken` authentication (`/api/v1/auth`) alongside standard web session cookies.
2. **Android (`clients/android`):**
   - Kotlin + `dev.hotwire:core` / `dev.hotwire:navigation-fragments` pointing to `BuildConfig.BASE_URL` (defaulting to the live Render URL).
   - Must compile and pass `./gradlew test lint assembleDebug` on Linux CI to emit an installable `.apk`.
3. **iOS (`clients/ios`):**
   - Swift + `hotwire-native-ios` Swift Package pointing to `AppConfig.baseURL` (live Render URL).
   - Keep core configuration and routing testable via `swift test` / Simulator `xcodebuild` on macOS CI; export `.ipa` when signing secrets are configured.
