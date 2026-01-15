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


// ID assigned to the status message element injected into the Migaku UI.
const statusMessageElemId = "mgkexporterStatusMessage";


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
 * Reads the list of decks from the SRS database.
 * @param {any} db - sql.js Database handle.
 * @returns {Object[]} Deck rows including deletion status.
 */
const fetchDeckList = (db) => {
    return fetchDbRowsAsObjectArray(db, "SELECT id, lang, name, del FROM deck;");
};

/**
 * Reads all cards for a given deck.
 * @param {any} db - sql.js Database handle.
 * @param {number} deckId - Deck identifier.
 * @returns {Object[]} Card rows for the specified deck.
 */
const fetchDeckCards = (db, deckId) => {
    return fetchDbRowsAsObjectArray(db, "SELECT id, mod, del, cardTypeId, created, primaryField, secondaryField, fields, words, due, interval, factor, lastReview, reviewCount, passCount, failCount, suspended FROM card WHERE deckId=?", [deckId]);
};

/**
 * Reads card type definitions and parses their JSON configs.
 * @param {any} db - sql.js Database handle.
 * @returns {Map<number, Object>} Map of card type id to card type object.
 */
const fetchCardTypes = (db) => {
    let rows = fetchDbRowsAsObjectArray(db, "SELECT id, del, lang, name, config FROM card_type");
    const res = new Map();
    for (const row of rows) {
        row.config = JSON.parse(row.config);
        res.set(row.id, row);
    }
    return res;
};

/**
 * Reads review history entries from the SRS database.
 * @param {any} db - sql.js Database handle.
 * @returns {Object[]} Review rows sorted by database order.
 */
const fetchReviewHistory = (db) => {
    return fetchDbRowsAsObjectArray(db, "SELECT id, mod, del, day, interval, factor, cardId, duration, type, lapseIndex FROM review");
};

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
 * Creates an empty Anki collection schema in a new sql.js database.
 * @param {any} SQL - sql.js module instance.
 * @returns {any} Initialized Anki-compatible database.
 */
const initNewAnkiSqlDb = (SQL) => {
    const db = new SQL.Database();
    db.run(`
        CREATE TABLE cards (
            id integer primary key,
            nid integer not null,
            did integer not null,
            ord integer not null,
            mod integer not null,
            usn integer not null,
            type integer not null,
            queue integer not null,
            due integer not null,
            ivl integer not null,
            factor integer not null,
            reps integer not null,
            lapses integer not null,
            left integer not null,
            odue integer not null,
            odid integer not null,
            flags integer not null,
            data text not null
        ) STRICT;
        CREATE TABLE col (
            id integer primary key,
            crt integer not null,
            mod integer not null,
            scm integer not null,
            ver integer not null,
            dty integer not null,
            usn integer not null,
            ls integer not null,
            conf text not null,
            models text not null,
            decks text not null,
            dconf text not null,
            tags text not null
        ) STRICT;
        CREATE TABLE graves (
            usn integer not null,
            oid integer not null,
            type integer not null
        ) STRICT;
        CREATE TABLE notes (
            id integer primary key,
            guid text not null,
            mid integer not null,
            mod integer not null,
            usn integer not null,
            tags text not null,
            flds text not null,
            sfld integer not null,
            csum integer not null,
            flags integer not null,
            data text not null
        ) STRICT;
        CREATE TABLE revlog (
            id integer primary key,
            cid integer not null,
            usn integer not null,
            ease integer not null,
            ivl integer not null,
            lastIvl integer not null,
            factor integer not null,
            time integer not null,
            type integer not null
        ) STRICT;
        CREATE INDEX ix_cards_nid on cards (nid);
        CREATE INDEX ix_cards_sched on cards (did, queue, due);
        CREATE INDEX ix_cards_usn on cards (usn);
        CREATE INDEX ix_notes_csum on notes (csum);
        CREATE INDEX ix_notes_usn on notes (usn);
        CREATE INDEX ix_revlog_cid on revlog (cid);
        CREATE INDEX ix_revlog_usn on revlog (usn);
    `);
    return db;
};

/**
 * Seeds the Anki col table and builds models/decks based on used card types.
 * @param {any} db - Anki sql.js database.
 * @param {Array<Object>} usedCardTypes - Card types referenced by exported cards.
 * @returns {Map<number, number>} Mapping of Migaku card type id to Anki model id.
 */
const ankiDbPutCol = (db, usedCardTypes) => {
    // TODO: Add fields for all the card types
    const cardTypeIdsToModelIds = new Map();
    usedCardTypes.forEach((x) => {
        if (!x) {
            window.alert("Bad card type entry");
            throw Error();
        }
        cardTypeIdsToModelIds.set(x.id, Date.now());
    });

    const conf = {
        curDeck: 1,
        curModel: cardTypeIdsToModelIds.get(usedCardTypes[0].id).toString(),
    };

    const models = {};
    for (const cardType of usedCardTypes) {
        const fields = [];
        const pushField = (name) => {
            fields.push({
                font: "Arial",
                media: [],
                name: name,
                ord: fields.length,
                rtl: false,
                size: 20,
                sticky: false,
            });
        };

        let template = null;
        switch (cardType.name) {
            case "Sentence":
                cardType.config.fields.forEach((x) => pushField(x.name));
                template = {
                    name: "Basic",
                    qfmt: "{{Word}}<br>{{Sentence}}",
                    did: null,
                    bafmt: "",
                    afmt: `
                        {{FrontSide}}<hr id="answer"><br>
                        {{Sentence Audio}}<br>
                        {{Word Audio}}<br>
                        {{Translated Sentence}}<br>
                        <div>{{Definitions}}</div><br>
                        {{Images}}<br>
                        <div>{{Example Sentences}}</div><br>
                        <div>{{Notes}}</div>
                    `,
                    ord: 0,
                    bqfmt: "",
                };
                break;
            case "Word": {
                cardType.config.fields.forEach((x) => pushField(x.name));
                const fieldNames = cardType.config.fields.map((f) => f.name);
                const answerBlocks = cardType.config.fields
                    .map((f) => `<div><b>${f.name}</b>: {{${f.name}}}</div>`)
                    .join("<br>");
                template = {
                    name: "Basic",
                    qfmt: fieldNames.length > 0 ? `{{${fieldNames[0]}}}` : "{{Front}}",
                    did: null,
                    bafmt: "",
                    afmt: `
                        {{FrontSide}}<hr id="answer"><br>
                        ${answerBlocks}
                    `,
                    ord: 0,
                    bqfmt: "",
                };
                break;
            }
            case "Audio Sentence":
            case "Audio Word":
            default:
                debugger;
                window.alert("Unimplemented card type: " + cardType.toString());
                throw Error();
        }

        if (!template) {
            window.alert("Internal error: Did not produce a card template for " + cardType.toString())
            throw Error("Bad template")
        }

        models[cardTypeIdsToModelIds.get(cardType.id)] = {
            css: "",
            did: 1,
            flds: fields,
            id: cardTypeIdsToModelIds.get(cardType.id),
            latexPost: "",
            latexPre: "",
            mod: Math.floor(Date.now() / 1000),
            name: "base",
            req: [], // unused
            sortf: 0,
            tags: [],
            tmpls: [template],
            type: 0, // standard
            usn: -1,
            vers: []
        };
    }

    const decks = {
        1: {
            name: "Default",
            extendRev: 10,
            usn: -1,
            collapsed: false,
            browserCollapsed: false,
            newToday: [0, 0],
            revToday: [0, 0],
            lrnToday: [0, 0],
            timeToday: [0, 0],
            dyn: 0,
            extendNew: 10,
            conf: 1,
            id: 1,
            mod: Date.now(),
            desc: "",
        }
    };

    const dconf = {
        1: {
            autoplay: false,
            id: 1,
            lapse: {
                delays: [10],
                leechAction: 0,
                leechFails: 8,
                minInt: 1,
                mult: 0,
            },
            maxTaken: 60,
            mod: 0,
            name: "Default",
            new: {
                bury: true,
                delays: [1, 10],
                initialFactor: 2500,
                ints: [1, 4, 7],
                order: 1,
                perDay: 20,
                separate: true,
            },
            replayq: true,
            rev: {
                bury: true,
                ease4: 1.3,
                fuzz: 0.05,
                ivlFct: 1,
                maxIvl: 36500,
                minSpace: 1,
                perDay: 100,
            },
            timer: 0,
            usn: -1,
        }
    };

    db.run(
        "INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            1, // id
            Math.floor(Date.now() / 1000), // crt
            Date.now(), // mod
            Date.now(), // scm
            11, // ver
            0, // dty
            0, // usn
            Date.now(), // ls
            JSON.stringify(conf), // conf
            JSON.stringify(models), // models
            JSON.stringify(decks), // decks
            JSON.stringify(dconf), // dconf
            "{}", // tags
        ]
    )
    return cardTypeIdsToModelIds;
};

/**
 * Updates both console and on-page status text.
 * @param {string} message - Status to display.
 */
const setStatus = (message) => {
    console.log(message);
    document.getElementById(statusMessageElemId).innerText = message;
};

/**
 * Writes notes/cards into the Anki database and zip (media is omitted).
 * @param {any} db - Anki sql.js database.
 * @param {JSZip} zipHandle - Zip instance collecting the apkg files.
 * @param {Map<number, Object[]>} cardsByCardType - Cards grouped by card type id.
 * @param {Map<number, Object>} cardTypes - Card type metadata keyed by id.
 * @param {Map<number, number>} cardTypeIdsToModelIds - Mapping from Migaku card type id to Anki model id.
 */
const ankiDbFillCards = async (db, zipHandle, cardsByCardType, cardTypes, cardTypeIdsToModelIds) => {
    setStatus("Converting cards")
    db.run("BEGIN TRANSACTION;");
    for (const typeKey of cardsByCardType.keys()) {
        const modelId = cardTypeIdsToModelIds.get(typeKey);
        const cardList = cardsByCardType.get(typeKey);
        const cardType = cardTypes.get(typeKey);
        const defCardFields = cardType.config.fields;
        let i = 0;
        for (const card of cardList) {
            const fieldsList = [];
            /**
             * Normalizes a Migaku field into Anki-safe content based on field type.
             * @param {string} x - Raw field value from Migaku.
             */
            const pushField = (x) => {
                const fieldIdx = fieldsList.length;
                if (fieldIdx >= defCardFields.length) return;
                const fieldInfo = defCardFields[fieldIdx];
                switch (fieldInfo.type) {
                    case "SYNTAX":
                        // Strip Migaku syntax markers for plain text export.
                        fieldsList.push(x.replaceAll(/\[.*?\]/g, "").replaceAll("{", "").replaceAll("}", ""));
                        break;
                    case "TEXT":
                        fieldsList.push(x);
                        break;
                    case "IMAGE":
                    case "AUDIO":
                    case "AUDIO_LONG":
                    default:
                        window.alert("Unable to handle card field definition: " + fieldInfo.toString());
                        break;
                }
            }
            pushField(card.primaryField);
            pushField(card.secondaryField);
            for (const part of card.fields.split("\u001f")) {
                pushField(part);
            }
            while (fieldsList.length < defCardFields.length) {
                fieldsList.push("");
            }

            const fieldsStr = fieldsList.join("\x1F");
            const fieldsChecksum = parseInt(
                Array.from(
                    new Uint8Array(
                        await window.crypto.subtle.digest(
                            "SHA-1",
                            new TextEncoder().encode(fieldsStr)
                        )
                    )
                ).map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 8),
                16
            );

            db.run(
                "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    card.id, // id,
                    crypto.randomUUID(), // guid
                    modelId, // mid
                    card.mod, // mod
                    -1, // usn
                    "", // tags
                    fieldsStr, // flds
                    i, // sfld
                    fieldsChecksum, // csum
                    0, // flags unused
                    "" // data unused
                ]
            )

            const cardTypeNum = card.reviewCount == 0 ? 0 : (card.interval > 1 ? 2 : 1);
            const cardQueueNum = cardTypeNum;
            let due = (cardTypeNum > 0) ? (card.due - card.lastReview) : i;
            if (cardTypeNum == 1) {
                // learning
                let date = new Date();
                date.setDate(date.getDate() + due);
                due = Math.floor(date.getTime() / 1000);
            }

            if (due < 0) {
                window.alert("Negative due date detected")
                debugger;
            }

            db.run(
                "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    card.id, // id
                    card.id, // nid
                    1, // did
                    0, // ord
                    card.mod, // mod
                    -1, // usn,
                    cardTypeNum, // type
                    cardQueueNum, // queue
                    due, // due
                    Math.floor(card.interval), // ivl
                    Math.floor(card.factor * 1000), // factor
                    card.reviewCount, // reps
                    card.failCount, // lapses
                    0, // left TODO
                    0, // odue
                    0, // odid
                    0, // flags
                    "", // data unused
                ]
            )
            i += 1;
        }
    }
    db.run("COMMIT");

    zipHandle.file("media", "{}");
};

/**
 * Inserts revlog rows derived from Migaku review history.
 * @param {any} db - Anki sql.js database.
 * @param {Object[]} reviewHistory - Migaku review events.
 * @param {Object[]} cards - Card list (unused but kept for parity).
 */
const ankiDbFillRevlog = (db, reviewHistory, cards) => {
    const revIntervals = new Map();
    reviewHistory.sort((a, b) => a.id - b.id);

    db.run("BEGIN TRANSACTION;");
    for (const review of reviewHistory) {
        let ease = 0;
        // 0 == learn?
        // 1 == fail?
        // 2 == pass?
        if (review.type === 0) {
            ease = 2; // ok (learn) TODO
        } else if (review.type === 1) {
            ease = 1; // wrong (review) TODO
        } else if (review.type == 2) {
            ease = 3; // ok (review) // TODO
        } else {
            window.alert("Unknown review type: " + review);
            debugger;
        }

        let prevInterval = 0;
        if (revIntervals.has(review.cardId)) {
            prevInterval = revIntervals.get(review.cardId);
        }

        db.run(
            "INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
                review.id, // id
                review.cardId, // cid
                -1, // usn
                ease, // ease
                Math.floor(review.interval), // ivl
                prevInterval, // lastIvl
                Math.floor(review.factor * 1000), // factor
                Math.min(review.duration, 60) * 1000, // time
                review.type === 0 ? 0 : 1, // type 0=learn 1=review
            ]
        );
        revIntervals.set(review.cardId, Math.floor(review.interval));
    }
    db.run("COMMIT");
};


/**
 * Orchestrates deck export: gather cards, build Anki DB, and download apkg.
 * @param {any} SQL - sql.js module instance.
 * @param {any} db - Migaku SRS database.
 * @param {number} deckId - Deck identifier.
 * @param {string} deckName - Deck name for the exported file.
 */
const doExportDeck = async (SQL, db, deckId, deckName) => {
    const cards = fetchDeckCards(db, deckId).filter((x) => !x.del);
    const cardTypes = fetchCardTypes(db);

    const cardsByCardType = new Map();
    for (const card of cards) {
        if (!cardsByCardType.has(card.cardTypeId)) {
            cardsByCardType.set(card.cardTypeId, []);
        }
        cardsByCardType.get(card.cardTypeId).push(card);
    }

    const usedCardTypes = Array.from(cardsByCardType.keys()).map((x) => cardTypes.get(x));

    let zip = new JSZip();
    const ankiDb = initNewAnkiSqlDb(SQL);

    const reviewHistory = fetchReviewHistory(db).filter((x) => !x.del);
    ankiDbFillRevlog(ankiDb, reviewHistory, cards);
    const cardTypeIdsToModelIds = ankiDbPutCol(ankiDb, usedCardTypes);
    await ankiDbFillCards(ankiDb, zip, cardsByCardType, cardTypes, cardTypeIdsToModelIds);

    const exportedDb = ankiDb.export();
    zip.file("collection.anki2", exportedDb);
    setStatus(`Constructing apkg file (be patient)`);
    zip.generateAsync({ type: "blob" }).then((zipBlob) => {
        setStatus("Done");

        const url = URL.createObjectURL(zipBlob);

        const dlElem = document.createElement("a");
        dlElem.href = url;
        dlElem.download = `Migaku - ${deckName}.apkg`;
        dlElem.style = "display: none;";
        document.body.appendChild(dlElem);

        dlElem.click();
    });
};

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

    const deckSelect = div.appendChild(document.createElement("select"));
    for (const deck of fetchDeckList(srsDb)) {
        if (deck.lang !== migakuLang) continue;
        if (deck.del) continue;
        const option = deckSelect.appendChild(document.createElement("option"));
        option.innerText = deck.name;
        option.value = deck.id;
    }

    const exportButton = div.appendChild(document.createElement("button"));
    exportButton.innerText = "Export deck";

    exportButton.onclick = async () => {
        const deckId = deckSelect.options[deckSelect.selectedIndex].value;
        const deckName = deckSelect.options[deckSelect.selectedIndex].innerText;
        await doExportDeck(SQL, srsDb, deckId, deckName);
    };

    const statusMessageElem = div.appendChild(document.createElement("div"));
    statusMessageElem.id = statusMessageElemId;

    const exportWordlistButton = div.appendChild(document.createElement("button"));
    exportWordlistButton.innerText = "Export word statuses";
    exportWordlistButton.onclick = async () => {
        await doExportWordlist(srsDb, migakuLang);
    };
}

waitForMigaku(() => {
    inject();
});
