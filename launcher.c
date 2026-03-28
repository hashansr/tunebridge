/*
 * TuneBridge launcher — path-independent Mach-O binary.
 *
 * Uses _NSGetExecutablePath() to locate itself at runtime, then derives
 * the bundle Resources directory. Reads .python-version from Resources,
 * tries the preferred version first, then falls through a full ordered
 * candidate list. Sets PYTHONPATH/TUNEBRIDGE_PROJECT_DIR/TUNEBRIDGE_BUNDLED
 * and exec()s into tunebridge_gui.py.
 */
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <libgen.h>
#include <mach-o/dyld.h>

/* Show an error dialog via osascript and return rc. */
static int show_dialog(const char *title, const char *msg) {
    char buf[2048];
    snprintf(buf, sizeof(buf),
             "osascript -e 'tell application \"System Events\" to display dialog"
             " \"%s\" with title \"%s\" buttons {\"OK\"} default button 1"
             " with icon stop'",
             msg, title);
    system(buf);
    return 1;
}

int main(void) {
    /* ── Locate ourself ──────────────────────────────────────────────────── */
    char exe_buf[4096];
    uint32_t exe_size = sizeof(exe_buf);
    if (_NSGetExecutablePath(exe_buf, &exe_size) != 0) {
        return show_dialog("TuneBridge", "Could not determine executable path.");
    }

    /* dirname() modifies its argument — work on copies */
    char macos_dir[4096];
    strncpy(macos_dir, exe_buf, sizeof(macos_dir) - 1);
    macos_dir[sizeof(macos_dir) - 1] = '\0';
    char *macos = dirname(macos_dir);   /* …/TuneBridge.app/Contents/MacOS */

    char contents_dir[4096];
    strncpy(contents_dir, macos, sizeof(contents_dir) - 1);
    contents_dir[sizeof(contents_dir) - 1] = '\0';
    char *contents = dirname(contents_dir); /* …/TuneBridge.app/Contents */

    /* ── Build paths ─────────────────────────────────────────────────────── */
    char resources[4096], script[4096], packages[4096], pyver_file[4096];
    snprintf(resources,  sizeof(resources),  "%s/Resources",              contents);
    snprintf(script,     sizeof(script),     "%s/tunebridge_gui.py",      resources);
    snprintf(packages,   sizeof(packages),   "%s/Packages",               resources);
    snprintf(pyver_file, sizeof(pyver_file), "%s/.python-version",        resources);

    /* ── Read preferred Python version from .python-version ─────────────── */
    char preferred_ver[32] = "";
    FILE *vf = fopen(pyver_file, "r");
    if (vf) {
        if (fgets(preferred_ver, sizeof(preferred_ver), vf)) {
            /* Strip trailing newline/whitespace */
            size_t len = strlen(preferred_ver);
            while (len > 0 && (preferred_ver[len-1] == '\n' ||
                                preferred_ver[len-1] == '\r' ||
                                preferred_ver[len-1] == ' ')) {
                preferred_ver[--len] = '\0';
            }
        }
        fclose(vf);
    }

    /* ── Build candidate list ────────────────────────────────────────────── */
    /*
     * The bundled Packages/ directory contains binary extensions (.so files)
     * compiled for the SPECIFIC Python version recorded in .python-version.
     * Using a different Python version causes ImportError (ABI mismatch).
     *
     * Strategy:
     *   1. If .python-version is present, try ONLY paths for that exact version.
     *      If none found, tell the user which Python to install.
     *   2. If .python-version is absent (should not happen), try any 3.10+
     *      as a last resort — the pure-Python parts may still work.
     *
     * Homebrew installs version-specific binaries at:
     *   /opt/homebrew/opt/python@X.Y/bin/python3.Y   (Apple Silicon)
     *   /usr/local/opt/python@X.Y/bin/python3.Y       (Intel)
     * and optionally symlinks /opt/homebrew/bin/python3.Y.
     * CLT 3.9 is intentionally excluded — it cannot load 3.10+ binary extensions.
     */

    char ver_pyorg[256]    = "";   /* python.org framework  */
    char ver_clt[256]      = "";   /* Xcode CLT framework   */
    char ver_hb_arm[256]   = "";   /* Homebrew Apple Silicon */
    char ver_hb_x86[256]   = "";   /* Homebrew Intel        */
    char ver_hb_arm_lnk[256] = ""; /* Homebrew arm64 symlink */
    char ver_hb_x86_lnk[256] = ""; /* Homebrew x86 symlink  */

    if (preferred_ver[0]) {
        /* Extract minor version number for Homebrew path (e.g. "3.12" → "12") */
        char minor_str[16] = "";
        const char *dot = strchr(preferred_ver, '.');
        if (dot) strncpy(minor_str, dot + 1, sizeof(minor_str) - 1);

        snprintf(ver_pyorg,  sizeof(ver_pyorg),
                 "/Library/Frameworks/Python.framework/Versions/%s/bin/python3",
                 preferred_ver);
        snprintf(ver_clt, sizeof(ver_clt),
                 "/Library/Developer/CommandLineTools/Library/Frameworks/"
                 "Python3.framework/Versions/%s/bin/python3",
                 preferred_ver);
        if (minor_str[0]) {
            snprintf(ver_hb_arm, sizeof(ver_hb_arm),
                     "/opt/homebrew/opt/python@%s/bin/python3.%s",
                     preferred_ver, minor_str);
            snprintf(ver_hb_x86, sizeof(ver_hb_x86),
                     "/usr/local/opt/python@%s/bin/python3.%s",
                     preferred_ver, minor_str);
            snprintf(ver_hb_arm_lnk, sizeof(ver_hb_arm_lnk),
                     "/opt/homebrew/bin/python3.%s", minor_str);
            snprintf(ver_hb_x86_lnk, sizeof(ver_hb_x86_lnk),
                     "/usr/local/bin/python3.%s", minor_str);
        }
    }

    /* Version-specific candidates (used when .python-version is present) */
    const char *ver_candidates[] = {
        ver_pyorg[0]      ? ver_pyorg      : NULL,
        ver_clt[0]        ? ver_clt        : NULL,
        ver_hb_arm[0]     ? ver_hb_arm     : NULL,
        ver_hb_x86[0]     ? ver_hb_x86     : NULL,
        ver_hb_arm_lnk[0] ? ver_hb_arm_lnk : NULL,
        ver_hb_x86_lnk[0] ? ver_hb_x86_lnk : NULL,
        NULL
    };

    /* Generic 3.10+ fallback (used only when .python-version is absent) */
    const char *any_candidates[] = {
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.13/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.12/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.11/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.10/bin/python3",
        "/opt/homebrew/opt/python@3.13/bin/python3.13",
        "/opt/homebrew/opt/python@3.12/bin/python3.12",
        "/opt/homebrew/opt/python@3.11/bin/python3.11",
        "/opt/homebrew/opt/python@3.10/bin/python3.10",
        "/usr/local/opt/python@3.13/bin/python3.13",
        "/usr/local/opt/python@3.12/bin/python3.12",
        "/usr/local/opt/python@3.11/bin/python3.11",
        "/usr/local/opt/python@3.10/bin/python3.10",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        NULL
    };

    const char **search = preferred_ver[0] ? ver_candidates : any_candidates;

    const char *python = NULL;
    for (int i = 0; search[i] != NULL; i++) {
        if (search[i][0] && access(search[i], X_OK) == 0) {
            python = search[i];
            break;
        }
    }

    if (!python) {
        char errmsg[512];
        if (preferred_ver[0]) {
            snprintf(errmsg, sizeof(errmsg),
                "Python %s is required but was not found.\\n\\n"
                "Install it from python.org/downloads/macos/ "
                "or run:\\n  brew install python@%s\\n\\n"
                "Then relaunch TuneBridge.",
                preferred_ver, preferred_ver);
        } else {
            snprintf(errmsg, sizeof(errmsg),
                "Python 3.10 or later is required.\\n\\n"
                "Download it from python.org/downloads/macos/ "
                "and relaunch TuneBridge.");
        }
        return show_dialog("TuneBridge — Python not found", errmsg);
    }

    /* ── Verify script exists ────────────────────────────────────────────── */
    if (access(script, R_OK) != 0) {
        char errmsg[512];
        snprintf(errmsg, sizeof(errmsg),
                 "Cannot find tunebridge_gui.py inside the bundle.\\n"
                 "The app may be corrupted — please re-download TuneBridge.");
        return show_dialog("TuneBridge — Missing file", errmsg);
    }

    /* ── Set environment variables ───────────────────────────────────────── */
    /* PYTHONPATH: prepend Packages dir to existing value (if any) */
    const char *existing_pp = getenv("PYTHONPATH");
    if (existing_pp && existing_pp[0]) {
        char new_pp[8192];
        snprintf(new_pp, sizeof(new_pp), "%s:%s", packages, existing_pp);
        setenv("PYTHONPATH", new_pp, 1);
    } else {
        setenv("PYTHONPATH", packages, 1);
    }

    setenv("TUNEBRIDGE_PROJECT_DIR", resources, 1);
    setenv("TUNEBRIDGE_BUNDLED", "1", 1);

    /* ── Hand off to Python ──────────────────────────────────────────────── */
    char *args[] = { (char *)python, script, NULL };
    execv(python, args);

    /* execv only returns on failure */
    return show_dialog("TuneBridge — Launch failed",
                       "Failed to launch Python.\\nTry re-installing TuneBridge.");
}
