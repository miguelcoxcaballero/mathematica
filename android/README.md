# App Android (WolframLab Aero)

APK mínima: una actividad con un `WebView` a pantalla completa que carga la web publicada
(`https://miguelcoxcaballero.github.io/mathematica/`). El progreso se guarda en el almacenamiento local del WebView
de la app (localStorage), que persiste entre sesiones y entra en la copia de seguridad automática de Android.

- `app/` — código fuente (manifest, `MainActivity.java`, recursos e iconos).
- `build.sh` — compila sin Gradle: `aapt2` → `javac` → `d8` → `zipalign` → `apksigner`. Necesita un JDK y, en `sdk/`,
  las build-tools (`android-14/`) y la plataforma 34 (`android-34/android.jar`) del SDK de Android.
- El `keystore.jks` de firma NO está en el repositorio. Si se recompila con otra clave, Android obliga a desinstalar la
  app anterior antes de instalar la nueva (y con ello se pierde el progreso guardado en la app: expórtalo antes desde
  Ajustes y progreso).
