package com.healthagent.sync

import android.os.Bundle
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity

/** מסך הסבר על השימוש בנתונים. Health Connect מציג אותו כשלוחצים "למה האפליקציה צריכה את זה" */
class PrivacyActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = (20 * resources.displayMetrics.density).toInt()
        setContentView(ScrollView(this).apply {
            addView(TextView(this@PrivacyActivity).apply {
                text = getString(R.string.privacy_text)
                textSize = 16f
                setPadding(pad, pad, pad, pad)
            })
        })
    }
}
