@echo off
:: 20x Uninstaller Launcher
:: Finds and runs the NSIS uninstaller, or removes the app manually if not found.

setlocal

set "INSTALL_DIR=%LOCALAPPDATA%\Programs\20x"
set "UNINSTALLER=%INSTALL_DIR%\Uninstall 20x.exe"
set "APPDATA_DIR=%APPDATA%\20x"

echo ============================================
echo   20x Uninstaller
echo ============================================
echo.

:: Try the NSIS uninstaller first (handles registry cleanup, shortcuts, etc.)
if exist "%UNINSTALLER%" (
    echo Found NSIS uninstaller. Launching...
    echo.
    start "" "%UNINSTALLER%"
    exit /b 0
)

:: Fallback: manual removal
echo NSIS uninstaller not found at:
echo   %UNINSTALLER%
echo.
echo Proceeding with manual removal...
echo.

:: Ask about app data
set /p REMOVE_DATA="Remove your 20x data (tasks, settings, attachments)? [y/N]: "

:: Remove install directory
if exist "%INSTALL_DIR%" (
    echo Removing installation directory...
    rmdir /s /q "%INSTALL_DIR%"
    echo   Done.
) else (
    echo Installation directory not found, skipping.
)

:: Remove app data if requested
if /i "%REMOVE_DATA%"=="y" (
    if exist "%APPDATA_DIR%" (
        echo Removing app data...
        rmdir /s /q "%APPDATA_DIR%"
        echo   Done.
    ) else (
        echo App data directory not found, skipping.
    )
) else (
    echo Keeping app data.
)

:: Remove Start Menu shortcut
set "START_MENU=%APPDATA%\Microsoft\Windows\Start Menu\Programs\20x.lnk"
if exist "%START_MENU%" (
    echo Removing Start Menu shortcut...
    del "%START_MENU%"
)

:: Remove Desktop shortcut
set "DESKTOP=%USERPROFILE%\Desktop\20x.lnk"
if exist "%DESKTOP%" (
    echo Removing Desktop shortcut...
    del "%DESKTOP%"
)

echo.
echo ============================================
echo   20x has been uninstalled.
echo ============================================
pause
