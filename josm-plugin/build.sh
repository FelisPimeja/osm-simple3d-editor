#!/bin/sh
# Сборка simple3d.jar: нужен JDK 17+ (JAVA_HOME или javac в PATH) и josm-custom.jar / josm-tested.jar.
# JOSM_JAR — путь к jar JOSM; по умолчанию — из JOSM.app на macOS.
set -e
cd "$(dirname "$0")"
JOSM_JAR=${JOSM_JAR:-/Applications/JOSM.app/Contents/app/josm-custom.jar}
JAVAC=${JAVA_HOME:+$JAVA_HOME/bin/}javac
JAR=${JAVA_HOME:+$JAVA_HOME/bin/}jar
rm -rf build && mkdir -p build/classes
"$JAVAC" --release 17 -encoding UTF-8 -cp "$JOSM_JAR" -d build/classes $(find src -name '*.java')
"$JAR" cfm build/simple3d.jar MANIFEST.MF -C build/classes .
echo "build/simple3d.jar"
