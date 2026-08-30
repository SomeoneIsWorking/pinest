import java.util.Properties

// Release signing comes from android/key.properties. A release build without
// that durable identity fails unless CI explicitly requests an unsigned APK
// with ORG_GRADLE_PROJECT_pinestUnsignedRelease=true. The modes are mutually
// exclusive so an unsigned build cannot silently ignore configured signing.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) keystorePropertiesFile.inputStream().use { load(it) }
}
val hasReleaseKeystore = keystorePropertiesFile.exists()
val unsignedReleaseRequested = providers.gradleProperty("pinestUnsignedRelease").orNull?.let { value ->
    value.toBooleanStrictOrNull()
        ?: throw GradleException("pinestUnsignedRelease must be exactly 'true' or 'false'.")
} ?: false
val releaseBuildRequested = gradle.startParameter.taskNames.any {
    it.contains("release", ignoreCase = true)
}

if (releaseBuildRequested && unsignedReleaseRequested && hasReleaseKeystore) {
    throw GradleException(
        "Unsigned Android release requested while android/key.properties exists; " +
            "remove the signing configuration or omit pinestUnsignedRelease.",
    )
}

if (releaseBuildRequested && !unsignedReleaseRequested && !hasReleaseKeystore) {
    throw GradleException(
        "Android release signing requires android/key.properties; " +
            "configure the durable PiNest release keystore or explicitly request the CI-only " +
            "unsigned mode with ORG_GRADLE_PROJECT_pinestUnsignedRelease=true.",
    )
}

plugins {
    id("com.android.application")
    // START: FlutterFire Configuration
    id("com.google.gms.google-services")
    // END: FlutterFire Configuration
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.barishamil.pinest"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "com.barishamil.pinest"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            if (hasReleaseKeystore && !unsignedReleaseRequested) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
