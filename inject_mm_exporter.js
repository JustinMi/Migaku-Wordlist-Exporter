// ==UserScript==
// @name        Migaku deck exporter
// @namespace   Violentmonkey Scripts
// @match       https://study.migaku.com/*
// @grant       GM_getResourceURL
// @version     1.5
// @author      -
// @description 29/05/2025, 13:09:19
// @require      data:application/javascript,%3BglobalThis.setImmediate%3DsetTimeout%3B
// @require https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js
// @resource sql_wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm
// @require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==


/**
 * Decompresses a gzipped Blob into a Uint8Array.
 * @param {Blob} blob - Gzipped blob read from IndexedDB.
 * @returns {Promise<Uint8Array>} Resolved with the decompressed bytes.
 */
const decompress = async (blob) => {
    const ds = new DecompressionStream("gzip");
    const decompressedStream = blob.stream().pipeThrough(ds);
    const reader = decompressedStream.getReader();
    const chunks = [];
    let totalSize = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.byteLength;
    }
    const res = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        res.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return res;
};



/**
 * Loads the compressed Migaku SRS IndexedDB database and decompresses it.
 * @returns {Promise<Uint8Array>} Raw SQLite bytes for the SRS database.
 */
const fetchRawSrsDb = () => {
    return new Promise((resolve) => {
        console.log("Fetching raw database")
        const dbRequest = indexedDB.open('srs', 1);
        dbRequest.onsuccess = function (event) {
            const idb = dbRequest.result;

            const transaction = idb.transaction('data', 'readonly');
            const objectStore = transaction.objectStore('data');

            const cursorRequest = objectStore.openCursor();
            cursorRequest.onsuccess = function (ev) {
                if (cursorRequest.result) {
                    const cursor = cursorRequest.result;
                    const data = cursor.value.data;

                    const blob = new Blob([data], { type: "application/octet-stream" });
                    decompress(blob).then((decompressedDb) => {
                        resolve(decompressedDb);
                    });
                    cursor.continue();
                }
            };
            idb.close();
        };
    });
};

/**
 * Reads the currently selected language from the Migaku page.
 * @returns {string} Language code configured in the Migaku UI.
 */
const queryMigakuSelectedLanguage = () => {
    return document.querySelector("main.MIGAKU-SRS").getAttribute("data-mgk-lang-selected");
}


/**
 * Opens the Migaku SRS SQLite database using sql.js.
 * @param {any} SQL - sql.js module instance.
 * @returns {Promise<any>} sql.js Database instance.
 */
const openSrsDb = (SQL) => {
    return new Promise((resolve) => {
        fetchRawSrsDb().then((raw) => {
            resolve(new SQL.Database(raw));
        });
    });
}

/** 
 * Converts a raw sql.js row into an object keyed by column names.
 * @param {string[]} columnNames - Column names returned by sql.js.
 * @param {any[]} rowVals - Raw row values returned by sql.js.
 * @returns {Object} Plain object representation of the row.
 */
const convDbRowToObject = (columnNames, rowVals) => {
    const row = {};
    let i = 0;
    for (const colName of columnNames) {
        if (colName == "del") {
            row[colName] = rowVals[i] !== 0;
        } else {
            row[colName] = rowVals[i];
        }
        i += 1;
    }
    return row;
};

/**
 * Converts sql.js result set into an array of objects.
 * @param {{columns: string[], values: any[][]}} dbRes - sql.js execution result.
 * @returns {Object[]} Array of row objects keyed by column name.
 */
const convDbRowsToObjectArray = (dbRes) => {
    const res = [];
    for (const val of dbRes.values) {
        res.push(convDbRowToObject(dbRes.columns, val));
    }
    return res;
};

/**
 * Executes a SQL query and returns the rows as plain objects.
 * @param {any} db - sql.js Database handle.
 * @param {string} query - SQL query string with placeholders.
 * @param {any[]} [args] - Optional parameters for the query.
 * @returns {Object[]} Rows returned by the query.
 */
const fetchDbRowsAsObjectArray = (db, query, args) => {
    return convDbRowsToObjectArray(
        db.exec(query, args)[0]
    );
}


/**
 * Fetches word list entries for a specific language.
 * @param {any} db - sql.js Database handle.
 * @param {string} lang - Language code.
 * @returns {Object[]} Word list rows for the language.
 */
const fetchWordListForLang = (db, lang) => {
    return fetchDbRowsAsObjectArray(db, "SELECT dictForm, secondary, partOfSpeech, language, mod, serverMod, del, knownStatus, hasCard, tracked FROM WordList WHERE language=?", [lang]);
}


/**
 * Exports Migaku word status lists as CSV files bundled in a zip.
 * @param {any} db - Migaku SRS database.
 * @param {string} lang - Language code to export.
 */
const doExportWordlist = async (db, lang) => {
    const wordList = fetchWordListForLang(db, lang);

    const unknown = new Array();
    const ignored = new Array();
    const learning = new Array();
    const known = new Array();
    const tracked = new Array();

    for (const word of wordList) {
        if (word.del) continue;
        switch (word.knownStatus) {
            case "UNKNOWN":
                unknown.push(word);
                break;
            case "IGNORED":
                ignored.push(word);
                break;
            case "LEARNING":
                learning.push(word);
                break;
            case "KNOWN":
                known.push(word);
                break;
            default:
                console.log("UNKNOWN WORD STATUS: " + word.knownStatus);
                break;
        }
        if (word.tracked) {
            tracked.push(word);
        }
    }

    /**
     * Escapes a CSV cell by doubling quotes and wrapping in quotes.
     * @param {string} x - Raw string value.
     * @returns {string} CSV-safe cell.
     */
    const escape = (x) => {
        return '"' + x.replaceAll('"', '""') + '"';
    }

    /**
     * Serializes a list of word entries to CSV text.
     * @param {Object[]} arr - Word entries with dictForm/secondary/hasCard.
     * @returns {string} CSV representation of the list.
     */
    const arrToCsv = (arr) => {
        const header = "dictForm,secondary,hasCard";
        const rows = new Array();
        for (const word of arr) {
            rows.push(`${escape(word.dictForm)},${escape(word.secondary)},${word.hasCard}`);
        }
        return header + "\n" + rows.join("\n");
    };

    let zip = new JSZip();
    zip.file("unknown.csv", arrToCsv(unknown));
    zip.file("ignored.csv", arrToCsv(ignored));
    zip.file("learning.csv", arrToCsv(learning));
    zip.file("known.csv", arrToCsv(known));
    zip.file("tracked.csv", arrToCsv(tracked));
    zip.generateAsync({ type: "blob" }).then((zipBlob) => {
        const url = URL.createObjectURL(zipBlob);

        const dlElem = document.createElement("a");
        dlElem.href = url;
        dlElem.download = `wordlists.zip`;
        dlElem.style = "display: none;";
        document.body.appendChild(dlElem);

        dlElem.click();
    });
};


/**
 * Waits for the Migaku decks area to render before injecting UI.
 * @param {Function} cb - Callback invoked once the UI is available.
 */
function waitForMigaku(cb) {
    const observer = new MutationObserver((_, observer) => {
        if (document.querySelector(".HomeDecks")) {
            observer.disconnect();
            cb();
        }
    });
    observer.observe(document, { childList: true, subtree: true });
};


// Cache the sql.js-backed SRS database once opened to avoid reloading.
let srsDb = null;

/**
 * Entry point that wires UI controls and kicks off exports.
 */
const inject = async () => {
    const SQL = await initSqlJs({ locateFile: () => GM_getResourceURL("sql_wasm") });

    srsDb = await openSrsDb(SQL);
    const migakuLang = queryMigakuSelectedLanguage();

    const div = document.querySelector(".HomeDecks").appendChild(document.createElement("div"));

    const exportWordlistButton = div.appendChild(document.createElement("button"));
    exportWordlistButton.innerText = "Export word statuses";
    exportWordlistButton.onclick = async () => {
        await doExportWordlist(srsDb, migakuLang);
    };
}

waitForMigaku(() => {
    inject();
});
