package com.healthagent.sync

import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.aggregate.AggregateMetric
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.TotalCaloriesBurnedRecord
import androidx.health.connect.client.records.Vo2MaxRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.AggregateGroupByDurationRequest
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import kotlin.reflect.KClass

/**
 * קורא חלון זמן מ-Health Connect ובונה payload בפורמט health-agent-android/1
 * (המתאם בצד השרת: supabase/functions/_shared/adapters/health-connect.ts).
 *
 * צעדים, מרחק, קלוריות ודופק נקראים דרך ה-aggregate API ולא כרשומות גולמיות:
 * כשגם הטלפון וגם השעון סופרים צעדים, Health Connect מנכה את הכפילויות בעצמו.
 * נקרא רק מה שיש עליו הרשאה. סוג נתונים בלי הרשאה פשוט לא נשלח.
 */
class HealthReader(private val client: HealthConnectClient, private val granted: Set<String>) {

    private fun has(type: KClass<out Record>) = HealthPermission.getReadPermission(type) in granted

    suspend fun build(from: Instant, to: Instant, appVersion: String, device: String): JSONObject =
        JSONObject()
            .put("schema", SCHEMA)
            .put("app_version", appVersion)
            .put("device", device)
            .put("range", JSONObject().put("from", ts(from, null)).put("to", ts(to, null)))
            .put("hourly", hourly(from, to))
            .put("points", points(from, to))
            .put("sleep", sleep(from, to))
            .put("exercise", exercise(from, to))

    // ------------------------------------------------------------ לפי שעה

    private suspend fun hourly(from: Instant, to: Instant): JSONArray {
        val metrics = mutableSetOf<AggregateMetric<*>>()
        if (has(StepsRecord::class)) metrics += StepsRecord.COUNT_TOTAL
        if (has(DistanceRecord::class)) metrics += DistanceRecord.DISTANCE_TOTAL
        if (has(ActiveCaloriesBurnedRecord::class)) metrics += ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
        if (has(HeartRateRecord::class)) metrics += setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX)
        val out = JSONArray()
        if (metrics.isEmpty()) return out

        // חלוקה לשעות עגולות, כדי ששליחה חוזרת תפגוש בדיוק את אותם חלונות בשרת
        val start = from.truncatedTo(ChronoUnit.HOURS)
        val groups = client.aggregateGroupByDuration(
            AggregateGroupByDurationRequest(metrics, TimeRangeFilter.between(start, to), Duration.ofHours(1)),
        )
        for (g in groups) {
            val r = g.result
            val steps = r[StepsRecord.COUNT_TOTAL]
            val dist = r[DistanceRecord.DISTANCE_TOTAL]?.inMeters
            val kcal = r[ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL]?.inKilocalories
            val hrAvg = r[HeartRateRecord.BPM_AVG]
            if (steps == null && dist == null && kcal == null && hrAvg == null) continue
            out.put(
                JSONObject()
                    .put("start", ts(g.startTime, g.zoneOffset))
                    .put("end", ts(g.endTime, g.zoneOffset))
                    .putOpt("steps", steps)
                    .putOpt("distance_m", dist)
                    .putOpt("active_kcal", kcal)
                    .putOpt("hr_avg", hrAvg)
                    .putOpt("hr_min", r[HeartRateRecord.BPM_MIN])
                    .putOpt("hr_max", r[HeartRateRecord.BPM_MAX]),
            )
        }
        return out
    }

    // ------------------------------------------------------------ מדידות נקודתיות

    private suspend fun points(from: Instant, to: Instant): JSONArray {
        val out = JSONArray()
        fun add(type: String, time: Instant, offset: ZoneOffset?, value: Double, origin: String) {
            out.put(JSONObject().put("type", type).put("time", ts(time, offset)).put("value", value).put("origin", origin))
        }
        if (has(RestingHeartRateRecord::class)) readAll(RestingHeartRateRecord::class, from, to)
            .forEach { add("resting_heart_rate", it.time, it.zoneOffset, it.beatsPerMinute.toDouble(), it.metadata.dataOrigin.packageName) }
        if (has(HeartRateVariabilityRmssdRecord::class)) readAll(HeartRateVariabilityRmssdRecord::class, from, to)
            .forEach { add("hrv_rmssd", it.time, it.zoneOffset, it.heartRateVariabilityMillis, it.metadata.dataOrigin.packageName) }
        if (has(WeightRecord::class)) readAll(WeightRecord::class, from, to)
            .forEach { add("weight", it.time, it.zoneOffset, it.weight.inKilograms, it.metadata.dataOrigin.packageName) }
        if (has(BodyFatRecord::class)) readAll(BodyFatRecord::class, from, to)
            .forEach { add("body_fat", it.time, it.zoneOffset, it.percentage.value, it.metadata.dataOrigin.packageName) }
        if (has(OxygenSaturationRecord::class)) readAll(OxygenSaturationRecord::class, from, to)
            .forEach { add("spo2", it.time, it.zoneOffset, it.percentage.value, it.metadata.dataOrigin.packageName) }
        if (has(RespiratoryRateRecord::class)) readAll(RespiratoryRateRecord::class, from, to)
            .forEach { add("respiratory_rate", it.time, it.zoneOffset, it.rate, it.metadata.dataOrigin.packageName) }
        if (has(Vo2MaxRecord::class)) readAll(Vo2MaxRecord::class, from, to)
            .forEach { add("vo2max", it.time, it.zoneOffset, it.vo2MillilitersPerMinuteKilogram, it.metadata.dataOrigin.packageName) }
        return out
    }

    // ------------------------------------------------------------ שינה

    private suspend fun sleep(from: Instant, to: Instant): JSONArray {
        val out = JSONArray()
        if (!has(SleepSessionRecord::class)) return out
        // לילה שהתחיל לפני תחילת החלון עדיין רלוונטי: מרחיבים 12 שעות אחורה
        for (s in readAll(SleepSessionRecord::class, from.minus(Duration.ofHours(12)), to)) {
            val stages = JSONArray()
            s.stages.forEach {
                stages.put(
                    JSONObject().put("stage", STAGES[it.stage] ?: "unknown")
                        .put("start", ts(it.startTime, s.startZoneOffset)).put("end", ts(it.endTime, s.endZoneOffset)),
                )
            }
            out.put(
                JSONObject().put("id", s.metadata.id).put("origin", s.metadata.dataOrigin.packageName)
                    .put("start", ts(s.startTime, s.startZoneOffset)).put("end", ts(s.endTime, s.endZoneOffset))
                    .put("stages", stages),
            )
        }
        return out
    }

    // ------------------------------------------------------------ אימונים

    private suspend fun exercise(from: Instant, to: Instant): JSONArray {
        val out = JSONArray()
        if (!has(ExerciseSessionRecord::class)) return out
        for (e in readAll(ExerciseSessionRecord::class, from, to)) {
            val metrics = mutableSetOf<AggregateMetric<*>>()
            if (has(HeartRateRecord::class)) metrics += setOf(HeartRateRecord.BPM_AVG, HeartRateRecord.BPM_MIN, HeartRateRecord.BPM_MAX)
            if (has(DistanceRecord::class)) metrics += DistanceRecord.DISTANCE_TOTAL
            if (has(ActiveCaloriesBurnedRecord::class)) metrics += ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL
            if (has(TotalCaloriesBurnedRecord::class)) metrics += TotalCaloriesBurnedRecord.ENERGY_TOTAL
            if (has(StepsRecord::class)) metrics += StepsRecord.COUNT_TOTAL
            val range = TimeRangeFilter.between(e.startTime, e.endTime)
            val agg = if (metrics.isEmpty()) null else client.aggregate(AggregateRequest(metrics, range))

            // עקומת דופק: דגימה אחת לדקה מספיקה לניתוח, ושומרת את ה-payload קטן
            val hr = JSONArray()
            if (has(HeartRateRecord::class)) {
                var lastMinute = Long.MIN_VALUE
                readAll(HeartRateRecord::class, e.startTime, e.endTime)
                    .flatMap { it.samples }
                    .sortedBy { it.time }
                    .forEach {
                        val minute = it.time.epochSecond / 60
                        if (minute != lastMinute) {
                            hr.put(JSONObject().put("time", ts(it.time, e.startZoneOffset)).put("bpm", it.beatsPerMinute))
                            lastMinute = minute
                        }
                    }
            }

            out.put(
                JSONObject()
                    .put("id", e.metadata.id).put("origin", e.metadata.dataOrigin.packageName)
                    .put("type", e.exerciseType).put("type_name", EXERCISE_TYPES[e.exerciseType] ?: "TYPE_${e.exerciseType}")
                    .putOpt("title", e.title).putOpt("notes", e.notes)
                    .put("start", ts(e.startTime, e.startZoneOffset)).put("end", ts(e.endTime, e.endZoneOffset))
                    .putOpt("distance_m", agg?.get(DistanceRecord.DISTANCE_TOTAL)?.inMeters)
                    .putOpt("active_kcal", agg?.get(ActiveCaloriesBurnedRecord.ACTIVE_CALORIES_TOTAL)?.inKilocalories)
                    .putOpt("total_kcal", agg?.get(TotalCaloriesBurnedRecord.ENERGY_TOTAL)?.inKilocalories)
                    .putOpt("hr_avg", agg?.get(HeartRateRecord.BPM_AVG))
                    .putOpt("hr_min", agg?.get(HeartRateRecord.BPM_MIN))
                    .putOpt("hr_max", agg?.get(HeartRateRecord.BPM_MAX))
                    .putOpt("steps", agg?.get(StepsRecord.COUNT_TOTAL))
                    .put("hr_samples", hr),
            )
        }
        return out
    }

    // ------------------------------------------------------------ עזרים

    private suspend fun <T : Record> readAll(type: KClass<T>, from: Instant, to: Instant): List<T> {
        val out = mutableListOf<T>()
        var page: String? = null
        do {
            val resp = client.readRecords(ReadRecordsRequest(type, TimeRangeFilter.between(from, to), pageToken = page))
            out += resp.records
            page = resp.pageToken
        } while (page != null)
        return out
    }

    companion object {
        const val SCHEMA = "health-agent-android/1"

        /** ISO 8601 עם ה-offset המקורי של הרשומה (או של הטלפון), כמו שהשרת מצפה */
        fun ts(i: Instant, offset: ZoneOffset?): String =
            OffsetDateTime.ofInstant(i, offset ?: ZoneId.systemDefault()).format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)

        private val STAGES = mapOf(
            SleepSessionRecord.STAGE_TYPE_AWAKE to "awake",
            SleepSessionRecord.STAGE_TYPE_SLEEPING to "sleeping",
            SleepSessionRecord.STAGE_TYPE_OUT_OF_BED to "out_of_bed",
            SleepSessionRecord.STAGE_TYPE_LIGHT to "light",
            SleepSessionRecord.STAGE_TYPE_DEEP to "deep",
            SleepSessionRecord.STAGE_TYPE_REM to "rem",
            SleepSessionRecord.STAGE_TYPE_AWAKE_IN_BED to "awake_in_bed",
            SleepSessionRecord.STAGE_TYPE_UNKNOWN to "unknown",
        )

        // השמות כאן הם מה שהמתאם בשרת ממפה (EXERCISE_TYPES ב-health-connect.ts)
        private val EXERCISE_TYPES = mapOf(
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING to "RUNNING",
            ExerciseSessionRecord.EXERCISE_TYPE_RUNNING_TREADMILL to "RUNNING_TREADMILL",
            ExerciseSessionRecord.EXERCISE_TYPE_WALKING to "WALKING",
            ExerciseSessionRecord.EXERCISE_TYPE_HIKING to "HIKING",
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING to "BIKING",
            ExerciseSessionRecord.EXERCISE_TYPE_BIKING_STATIONARY to "BIKING_STATIONARY",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_POOL to "SWIMMING_POOL",
            ExerciseSessionRecord.EXERCISE_TYPE_SWIMMING_OPEN_WATER to "SWIMMING_OPEN_WATER",
            ExerciseSessionRecord.EXERCISE_TYPE_STRENGTH_TRAINING to "STRENGTH_TRAINING",
            ExerciseSessionRecord.EXERCISE_TYPE_WEIGHTLIFTING to "WEIGHTLIFTING",
            ExerciseSessionRecord.EXERCISE_TYPE_CALISTHENICS to "CALISTHENICS",
            ExerciseSessionRecord.EXERCISE_TYPE_HIGH_INTENSITY_INTERVAL_TRAINING to "HIGH_INTENSITY_INTERVAL_TRAINING",
            ExerciseSessionRecord.EXERCISE_TYPE_PILATES to "PILATES",
            ExerciseSessionRecord.EXERCISE_TYPE_YOGA to "YOGA",
            ExerciseSessionRecord.EXERCISE_TYPE_ELLIPTICAL to "ELLIPTICAL",
            ExerciseSessionRecord.EXERCISE_TYPE_ROWING_MACHINE to "ROWING_MACHINE",
            ExerciseSessionRecord.EXERCISE_TYPE_STAIR_CLIMBING_MACHINE to "STAIR_CLIMBING_MACHINE",
            ExerciseSessionRecord.EXERCISE_TYPE_DANCING to "DANCING",
            ExerciseSessionRecord.EXERCISE_TYPE_STRETCHING to "STRETCHING",
            ExerciseSessionRecord.EXERCISE_TYPE_OTHER_WORKOUT to "OTHER_WORKOUT",
        )
    }
}
