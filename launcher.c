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
     * Preferred version first (python.org path, then CLT path),
     * then full ordered fallback list.
     */
    char preferred_pyorg[256] = "";
    char preferred_clt[256]   = "";
    if (preferred_ver[0]) {
        snprintf(preferred_pyorg, sizeof(preferred_pyorg),
                 "/Library/Frameworks/Python.framework/Versions/%s/bin/python3",
                 preferred_ver);
        snprintf(preferred_clt, sizeof(preferred_clt),
                 "/Library/Developer/CommandLineTools/Library/Frameworks/"
                 "Python3.framework/Versions/%s/bin/python3",
                 preferred_ver);
    }

    const char *candidates[] = {
        /* preferred version — python.org then CLT */
        preferred_pyorg[0] ? preferred_pyorg : NULL,
        preferred_clt[0]   ? preferred_clt   : NULL,

        /* python.org installers (arm64 + x86_64 share these paths) */
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
        "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",

        /* Xcode CLT */
        "/Library/Developer/CommandLineTools/Library/Frameworks/"
            "Python3.framework/Versions/3.12/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/"
            "Python3.framework/Versions/3.11/bin/python3",
        "/Library/Developer/CommandLineTools/Library/Frameworks/"
            "Python3.framework/Versions/3.9/bin/python3",

        /* Homebrew */
        "/opt/homebrew/bin/python3",      /* arm64 */
        "/usr/local/bin/python3",         /* x86_64 */

        NULL
    };

    const char *python = NULL;
    for (int i = 0; candidates[i] != NULL; i++) {
        if (candidates[i][0] && access(candidates[i], X_OK) == 0) {
            python = candidates[i];
            break;
        }
    }

    if (!python) {
        return show_dialog("TuneBridge — Python not found",
            "Python 3.10 or later is required.\\n\\n"
            "Download it from python.org/downloads and re-launch TuneBridge.");
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
