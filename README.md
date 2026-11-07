# Grok Haus

Lovelace-Karte für Home Assistant. Chat, Bild erzeugen und Foto/Kamera laufen über die KI-Entitäten (`assist_pipeline` und `ai_task`), nicht über einen API-Key in der Karte.

Der Verlauf liegt in Home Assistant (`frontend/set_user_data`), nicht im Browser.

## HACS

1. HACS → Integrationen ist egal. Dashboard → drei Punkte → **Custom repositories**.
2. Repository: `WackEarl/grok-haus`
3. Kategorie: **Lovelace**
4. Danach **Grok Haus** herunterladen.
5. Die Karte neu laden (Browser-Cache leeren) und auf dem Dashboard hinzufügen.

## Karte

- **Pipeline:** Bevorzugt, zuletzt benutzt oder eine konkrete Assist-Pipeline.
- **AI Task:** die `ai_task.*`-Entität mit SuperGrok.
- **Kamera:** optional, für „Kamera“.

Foto-Upload braucht den Ordner `/media/grok-haus` und einen Admin. Ohne den Ordner bleibt die Kamera.

Grok sieht den Chat nur etwa fünf Minuten. Die Karte schickt nicht den alten Verlauf mit, nur den neuen Satz.
