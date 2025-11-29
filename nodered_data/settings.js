// nodered_data/settings.js

module.exports = {
    /***************************************************************************
     * Flow file / userdir
     ***************************************************************************/
    flowFile: 'flows.json',
    flowFilePretty: true,

    /***************************************************************************
     * Server settings
     ***************************************************************************/
    uiPort: process.env.PORT || 1880,

    // Editor unter /admin
    httpAdminRoot: '/admin',

    // HTTP-In-Knoten (z.B. /history, /debug/stats) unter /
    httpNodeRoot: '/',

    // Deine statische GUI aus /data/ui (im Container)
    // → /index.html, /styles.css, /app.js, ...
    httpStatic: '/data/ui',

    // KEIN httpStaticRoot nötig, weil deine HTML jetzt z.B. "styles.css" und "app.js"
    // relativ lädt (siehe Hinweis unten)

    /***************************************************************************
     * Runtime / Logging
     ***************************************************************************/
    diagnostics: {
        enabled: true,
        ui: true,
    },

    runtimeState: {
        enabled: false,
        ui: false,
    },

    telemetry: {
        // enabled: true,
    },

    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    /***************************************************************************
     * Editor
     ***************************************************************************/
    editorTheme: {
        projects: { enabled: false, workflow: { mode: "manual" } },
        codeEditor: { lib: "monaco", options: {} },
        markdownEditor: { mermaid: { enabled: true } },
        multiplayer: { enabled: false }
    },

    /***************************************************************************
     * Node settings
     ***************************************************************************/
    functionExternalModules: true,
    globalFunctionTimeout: 0,
    functionTimeout: 0,
    functionGlobalContext: {
        // z.B. os: require('os')
    },
    debugMaxLength: 1000,
    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    inboundWebSocketTimeout: 5000,
};
