/**
 * The exit codes of `ancilla-server` that mean something to the process that started it. The command line exits 0
 * after a clean close and 1 on any failure, the shutdown deadline included; the one code below is the only other.
 */

/**
 * The data folder is owned by a live Ancilla: the server never bound, never opened the store, and wrote one line on
 * stderr and nothing on stdout. 75 is `EX_TEMPFAIL` of BSD's sysexits ("try again later", which is what the user does
 * once the other Ancilla has closed): outside Node's own codes (1 to 13) and under 128, so it is never read as a signal.
 * The desktop shell has the same number as `EXIT_DATA_DIR_OWNED` in apps/desktop/src-tauri/src/main.rs, where it means
 * "show the already-running page; do not retry on another port and do not touch server-port"; a test holds the two
 * together.
 */
export const EXIT_DATA_DIR_OWNED = 75;
