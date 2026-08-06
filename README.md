# ReelWatchAI

ReelWatchAI is a local-only digital wellbeing companion that watches for repeated upward swipe gestures using OpenCV and presents its controls and reports in Gradio.
<img width="1458" height="852" alt="Screenshot 2026-08-06 212615" src="https://github.com/user-attachments/assets/ac383d96-659d-4b4c-8c9b-360448c0fef4" />

## Run locally

```powershell
python -m pip install -r requirements.txt
npm run dev
```

Open `http://127.0.0.1:7860` and select **Start local camera**.

## Privacy

Video is processed on the local device. The app records wellbeing alerts only in a local SQLite database and does not contact emergency services or other people.
