package com.healthagent.sync

import android.content.Context
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * סנכרון אחד: קורא מ-Health Connect ושולח לשרת בחלונות של יומיים.
 *
 * 🧠 כל ריצה שולחת שוב את 48 השעות האחרונות, גם אם כבר נשלחו. השעון מעביר נתונים
 *    לטלפון באיחור (שינה מגיעה רק אחרי הקימה), והשרת מעדכן במקום לשכפל. כך שום דבר
 *    לא "נופל בין הכיסאות" כמו שקורה עם "רק מה שחדש מאז הסנכרון הקודם".
 */
object Syncer {
    private val READ_TYPES = listOf(
        StepsRecord::class, DistanceRecord::class, ActiveCaloriesBurnedRecord::class, TotalCaloriesBurnedRecord::class,
        HeartRateRecord::class, RestingHeartRateRecord::class, HeartRateVariabilityRmssdRecord::class,
        SleepSessionRecord::class, ExerciseSessionRecord::class, WeightRecord::class, BodyFatRecord::class,
        OxygenSaturationRecord::class, RespiratoryRateRecord::class, Vo2MaxRecord::class,
    )
    val READ_PERMISSIONS: Set<String> = READ_TYPES.map { HealthPermission.getReadPermission(it) }.toSet()
    val ALL_PERMISSIONS: Set<String> = READ_PERMISSIONS +
        HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND +
        HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY

    private val RESEND: Duration = Duration.ofHours(48)
    private val FIRST_SYNC: Duration = Duration.ofDays(30)
    private val WINDOW: Duration = Duration.ofDays(2)

    class SyncException(message: String, val retryable: Boolean) : Exception(message)

    suspend fun run(context: Context): String {
        val settings = Settings(context)
        settings.lastAttemptAt = System.currentTimeMillis()
        try {
            if (!settings.isConfigured) throw SyncException("חסרים כתובת שרת וטוקן (hk_...)", false)
            if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
                throw SyncException("Health Connect לא זמין בטלפון", false)
            }
            val client = HealthConnectClient.getOrCreate(context)
            val granted = client.permissionController.getGrantedPermissions()
            if (granted.none { it in READ_PERMISSIONS }) throw SyncException("עוד לא אושרו הרשאות קריאה ב-Health Connect", false)

            val reader = HealthReader(client, granted)
            val now = Instant.now()
            val oldest = now.minus(FIRST_SYNC)
            var cursor = if (settings.syncedThrough == 0L) oldest else Instant.ofEpochMilli(settings.syncedThrough).minus(RESEND)
            if (cursor.isBefore(oldest)) cursor = oldest

            var windows = 0
            var bytes = 0L
            while (cursor.isBefore(now)) {
                val end = minOf(cursor.plus(WINDOW), now)
                val body = reader.build(cursor, end, BuildConfigInfo.VERSION, "${Build.MANUFACTURER} ${Build.MODEL}").toString()
                post(settings.url, settings.token, body)
                bytes += body.length
                windows++
                settings.syncedThrough = end.toEpochMilli()
                cursor = end
            }
            val status = "✅ סונכרן ${stamp(now)} (${windows} חלונות, ${bytes / 1024}KB)"
            settings.lastStatus = status
            return status
        } catch (e: SyncException) {
            settings.lastStatus = "⚠️ ${stamp(Instant.now())}: ${e.message}"
            throw e
        } catch (e: SecurityException) {
            // בדרך כלל: אין הרשאת קריאה ברקע, והסנכרון רץ מה-WorkManager
            settings.lastStatus = "⚠️ ${stamp(Instant.now())}: אין הרשאה (אולי חסרה הרשאת קריאה ברקע)"
            throw SyncException("אין הרשאה: ${e.message}", false)
        } catch (e: IOException) {
            settings.lastStatus = "⚠️ ${stamp(Instant.now())}: אין חיבור לשרת, ננסה שוב"
            throw SyncException("רשת: ${e.message}", true)
        }
    }

    private fun post(url: String, token: String, body: String) {
        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 20_000
            readTimeout = 90_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Authorization", "Bearer $token")
        }
        try {
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code in 200..299) return
            val err = runCatching { conn.errorStream?.bufferedReader()?.readText() }.getOrNull()?.take(300)
            when (code) {
                401 -> throw SyncException("הטוקן לא תקין או בוטל", false)
                413 -> throw SyncException("החבילה גדולה מדי לשרת", false)
                in 500..599 -> throw IOException("שגיאת שרת $code: $err")
                else -> throw SyncException("השרת החזיר $code: $err", false)
            }
        } finally {
            conn.disconnect()
        }
    }

    private fun stamp(i: Instant): String =
        DateTimeFormatter.ofPattern("dd.MM HH:mm").withZone(ZoneId.systemDefault()).format(i)
}

object BuildConfigInfo {
    const val VERSION = "1.0.0"
}
