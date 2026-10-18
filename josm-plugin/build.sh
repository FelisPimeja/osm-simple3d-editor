#!/bin/sh
# Сборка simple3d.jar: нужен JDK 17+ (JAVA_HOME или javac в PATH) и jar JOSM.
# JOSM_JAR — путь к jar JOSM; по умолчанию — из JOSM.app на macOS (в CI — josm-tested.jar).
# PLUGIN_VERSION — номер версии в манифесте (в CI — из тега josm-plugin-vN); по умолчанию dev.
set -e
cd "$(dirname "$0")"
JOSM_JAR=${JOSM_JAR:-/Applications/JOSM.app/Contents/app/josm-custom.jar}
PLUGIN_VERSION=${PLUGIN_VERSION:-dev}
JAVAC=${JAVA_HOME:+$JAVA_HOME/bin/}javac
JAR=${JAVA_HOME:+$JAVA_HOME/bin/}jar
rm -rf build && mkdir -p build/classes
"$JAVAC" --release 17 -encoding UTF-8 -cp "$JOSM_JAR" -d build/classes $(find src -name '*.java')
sed "s/^Plugin-Version: .*/Plugin-Version: $PLUGIN_VERSION/" MANIFEST.MF > build/MANIFEST.MF
"$JAR" cfm build/simple3d.jar build/MANIFEST.MF -C build/classes .
echo "build/simple3d.jar"
