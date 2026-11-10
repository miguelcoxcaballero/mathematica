#!/bin/bash
# Builds WolframLabAero.apk without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner
set -e
cd "$(dirname "$0")"
BT=sdk/android-14; PLAT=sdk/android-34/android.jar; APP=app; OUT=build
rm -rf $OUT && mkdir -p $OUT/res $OUT/gen $OUT/classes $OUT/dex
export JAVA_TOOL_OPTIONS=
$BT/aapt2 compile --dir $APP/res -o $OUT/res/res.zip
$BT/aapt2 link -o $OUT/base.apk -I $PLAT --manifest $APP/AndroidManifest.xml --java $OUT/gen --min-sdk-version 24 --target-sdk-version 34 --version-code "${VCODE:-1}" --version-name "${VNAME:-1.0}" $OUT/res/res.zip
javac -nowarn -source 8 -target 8 -classpath $PLAT -d $OUT/classes $(find $APP/src $OUT/gen -name '*.java') 2>&1 | grep -v "warning\|^Note\|^1 warning" || true
$BT/d8 --release --min-api 24 --lib $PLAT --output $OUT/dex $(find $OUT/classes -name '*.class')
cp $OUT/base.apk $OUT/unsigned.apk
(cd $OUT/dex && zip -q -j ../unsigned.apk classes.dex)
$BT/zipalign -f -p 4 $OUT/unsigned.apk $OUT/aligned.apk
[ -f keystore.jks ] || keytool -genkeypair -keystore keystore.jks -storepass wolframlab -keypass wolframlab -alias wolframlab -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=WolframLab Aero" >/dev/null 2>&1
$BT/apksigner sign --ks keystore.jks --ks-pass pass:wolframlab --key-pass pass:wolframlab --ks-key-alias wolframlab --out $OUT/WolframLabAero.apk $OUT/aligned.apk
$BT/apksigner verify --verbose $OUT/WolframLabAero.apk | head -6
ls -la $OUT/WolframLabAero.apk
