// nodered_data/settings.js

module.exports = {
    /***************************************************************************
     * Flow File und Userdir
     ***************************************************************************/
    flowFile: 'flows.json',
    flowFilePretty: true,

    /***************************************************************************
     * Security (vorerst alles offen – später adminAuth setzen)
     ***************************************************************************/
    // adminAuth: { ... },
    // httpNodeAuth: { ... },
    // httpStaticAuth: { ... },

    /***************************************************************************
     * Server Settings
     ***************************************************************************/
    uiPort: process.env.PORT || 1880,
    // lauschen auf allen Interfaces 
    // uiHost: "0.0.0.0",

    // Editor-UI unter /admin
    httpAdminRoot: '/admin',

    // HTTP-In-Nodes (z.B. /history, /debug/stats) unter /
    httpNodeRoot: '/',

    // Statische Dateien aus /data/ui unter /
    // (dieser Pfad ist der Container-Pfad, auf dem Host ist es ./ui)
    // Wenn httpStatic gesetzt ist, muss httpAdminRoot auf einen anderen Pfad
    // gelegt werden als '/', damit die Editor-UI erreichbar bleibt. 
    httpStatic: '/data/ui',

    // Optionales CORS für HTTP-Nodes / statische Dateien (vorerst aus)
    // httpNodeCors: { origin: "*", methods: "GET,PUT,POST,DELETE" },
    // httpStaticCors: { origin: "*", methods: "GET,PUT,POST,DELETE" },

    /***************************************************************************
     * Runtime-Einstellungen
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
        // updateNotification: true
    },

    logging: {
        console: {
            level: "info",
            metrics: false,
            audit: false
        }
    },

    // Wenn später Context persistent sein soll, auskommentieren:
    // contextStorage: {
    //     default: {
    //         module: "localfilesystem"
    //     },
    // },

    exportGlobalContextKeys: false,

    externalModules: {
        // Palette/Module-Install-Optionen kannst du bei Bedarf anpassen
    },

    /***************************************************************************
     * Editor Settings
     ***************************************************************************/
    // disableEditor: false,

    editorTheme: {
        palette: {
            // categories: [...]
        },
        projects: {
            enabled: false,
            workflow: {
                mode: "manual"
            }
        },
        codeEditor: {
            lib: "monaco",
            options: {
                // theme: "vs",
            }
        },
        markdownEditor: {
            mermaid: {
                enabled: true
            }
        },
        multiplayer: {
            enabled: false
        }
    },

    /***************************************************************************
     * Node Settings
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
