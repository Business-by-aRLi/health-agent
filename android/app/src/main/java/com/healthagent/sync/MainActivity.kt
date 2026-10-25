package com.healthagent.sync

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private lateinit var settings: Settings
    private lateinit var status: TextView

    private val requestPermissions = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) {
        refresh()
        if (it.any { p -> p in Syncer.READ_PERMISSIONS }) SyncWorker.schedule(this)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        settings = Settings(this)
        status = findViewById(R.id.status)

        val url = findViewById<EditText>(R.id.url).apply { setText(settings.url) }
        val token = findViewById<EditText>(R.id.token).apply { setText(settings.token) }

        findViewById<Button>(R.id.save).setOnClickListener {
            settings.url = url.text.toString()
            settings.token = token.text.toString()
            if (settings.isConfigured) {
                SyncWorker.schedule(this)
                toast(getString(R.string.saved))
            } else {
                toast(getString(R.string.invalid_settings))
            }
            refresh()
        }

        findViewById<Button>(R.id.permissions).setOnClickListener {
            when (HealthConnectClient.getSdkStatus(this)) {
                HealthConnectClient.SDK_AVAILABLE -> requestPermissions.launch(Syncer.ALL_PERMISSIONS)
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> openHealthConnectInStore()
                else -> toast(getString(R.string.hc_unavailable))
            }
        }

        findViewById<Button>(R.id.sync_now).setOnClickListener {
            status.text = getString(R.string.syncing)
            lifecycleScope.launch {
                runCatching { Syncer.run(this@MainActivity) }
                refresh()
            }
        }

        findViewById<Button>(R.id.privacy).setOnClickListener {
            startActivity(Intent(this, PrivacyActivity::class.java))
        }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        lifecycleScope.launch {
            val lines = mutableListOf<String>()
            if (HealthConnectClient.getSdkStatus(this@MainActivity) == HealthConnectClient.SDK_AVAILABLE) {
                val granted = HealthConnectClient.getOrCreate(this@MainActivity).permissionController.getGrantedPermissions()
                val read = granted.count { it in Syncer.READ_PERMISSIONS }
                lines += getString(R.string.permissions_status, read, Syncer.READ_PERMISSIONS.size)
                if (androidx.health.connect.client.permission.HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND !in granted) {
                    lines += getString(R.string.no_background)
                }
            } else {
                lines += getString(R.string.hc_unavailable)
            }
            lines += if (settings.isConfigured) getString(R.string.configured) else getString(R.string.not_configured)
            if (settings.lastStatus.isNotEmpty()) lines += settings.lastStatus
            status.text = lines.joinToString("\n")
        }
    }

    private fun openHealthConnectInStore() {
        val uri = Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding")
        startActivity(Intent(Intent.ACTION_VIEW, uri).setPackage("com.android.vending"))
    }

    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_LONG).show()
}
