# ReelWatchAI

ReelWatchAI is a local-only digital wellbeing companion that watches for repeated upward swipe gestures using OpenCV and presents its controls and reports in Gradio.

## Run locally

```powershell
python -m pip install -r requirements.txt
npm run dev
```

Open `http://127.0.0.1:7860` and select **Start local camera**.

## Privacy

Video is processed on the local device. The app records wellbeing alerts only in a local SQLite database and does not contact emergency services or other people.
