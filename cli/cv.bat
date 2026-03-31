@echo off
REM Commvault Kubernetes Management Tool
REM Usage: cv <command> [subcommand] [parameters]
REM Run "cv --help" for full command list
powershell -executionpolicy remotesigned -File "%~dp0cv.ps1" %*
