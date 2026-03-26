/*
 * TuneBridge launcher
 * Tiny Mach-O binary that sets up Python environment and hands off to
 * tunebridge_gui.py. Using the CLT Python (not venv) means this binary
 * itself needs no access to ~/Documents — the TCC prompt fires naturally
 * the first time Python tries to open the script.
 */
#include <stdlib.h>
#include <unistd.h>

#define PROJECT "/Users/hashan/Documents/Claude/Projects/Playlist Creator"
#define PYTHON  "/Library/Developer/CommandLineTools/Library/Frameworks/" \
                "Python3.framework/Versions/3.9/bin/python3"
#define SCRIPT  PROJECT "/tunebridge_gui.py"
#define PYPATH  PROJECT "/venv/lib/python3.9/site-packages"

int main(void) {
    /* Point Python at the venv packages without activating the venv
       (activation reads pyvenv.cfg which is in ~/Documents and would
        trigger TCC before we even get a prompt on some macOS versions) */
    setenv("PYTHONPATH", PYPATH, 1);
    setenv("TUNEBRIDGE_PROJECT_DIR", PROJECT, 1);

    char *args[] = { PYTHON, SCRIPT, NULL };
    execv(PYTHON, args);
    return 1; /* execv only returns on failure */
}
