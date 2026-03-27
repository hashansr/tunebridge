"""
py2app build script for TuneBridge.app
Run via: python setup_app.py py2app
"""
from setuptools import setup

PROJECT_DIR = "/Users/hashan/Documents/Claude/Projects/Playlist Creator"

APP = ['tunebridge_gui.py']

OPTIONS = {
    'packages': [
        'webview', 'flask', 'waitress', 'mutagen',
        'bottle', 'proxy_tools', 'jinja2', 'markupsafe',
        'werkzeug', 'click', 'itsdangerous',
    ],
    'includes': [
        'webview.platforms.cocoa',
        'objc',
        'AppKit', 'Foundation', 'WebKit', 'Quartz',
    ],
    'iconfile': 'static/TuneBridge.icns',
    'plist': {
        'CFBundleName': 'TuneBridge',
        'CFBundleDisplayName': 'TuneBridge',
        'CFBundleIdentifier': 'com.tunebridge.app',
        'CFBundleVersion': '1.0',
        'CFBundleShortVersionString': '1.0',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '12.0',
        'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        'LSEnvironment': {
            'TUNEBRIDGE_PROJECT_DIR': PROJECT_DIR,
        },
        # Request access to Documents folder
        'NSDocumentsFolderUsageDescription':
            'TuneBridge needs access to your Documents folder to reach your music library and playlists.',
    },
}

setup(
    name='TuneBridge',
    app=APP,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
