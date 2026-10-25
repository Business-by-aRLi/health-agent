pluginManagement {
    repositories {
        google()
        // מראה של Google ל-Maven Central: לפני mavenCentral(), כי Maven Central מגביל קצב (429) בסביבות CI
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        // מראה של Google ל-Maven Central: לפני mavenCentral(), כי Maven Central מגביל קצב (429) בסביבות CI
        maven("https://maven-central.storage-download.googleapis.com/maven2/")
        mavenCentral()
    }
}
rootProject.name = "HealthAgentSync"
include(":app")
