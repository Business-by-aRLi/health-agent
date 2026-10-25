package com.healthagent.sync

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * הגדרות האפליקציה. הטוקן נשמר מוצפן במפתח של Android Keystore, כך שגם גיבוי או
 * גישה לקבצי האפליקציה לא חושפים אותו.
 */
class Settings(context: Context) {
    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "health_agent_sync",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    var url: String
        get() = prefs.getString("url", DEFAULT_URL) ?: DEFAULT_URL
        set(v) = prefs.edit().putString("url", v.trim()).apply()

    var token: String
        get() = prefs.getString("token", "") ?: ""
        set(v) = prefs.edit().putString("token", v.trim()).apply()

    /** עד איזה רגע (epoch ms) הנתונים כבר נשלחו בהצלחה. 0 = עוד לא היה סנכרון */
    var syncedThrough: Long
        get() = prefs.getLong("synced_through", 0L)
        set(v) = prefs.edit().putLong("synced_through", v).apply()

    var lastStatus: String
        get() = prefs.getString("last_status", "") ?: ""
        set(v) = prefs.edit().putString("last_status", v).apply()

    var lastAttemptAt: Long
        get() = prefs.getLong("last_attempt", 0L)
        set(v) = prefs.edit().putLong("last_attempt", v).apply()

    val isConfigured: Boolean get() = url.startsWith("https://") && token.startsWith("hk_")

    companion object {
        const val DEFAULT_URL = "https://hwcgxyreboaqjoxrofgw.supabase.co/functions/v1/ingest-healthkit"
    }
}
