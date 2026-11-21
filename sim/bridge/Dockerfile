# PX4 ⇄ browser bridge: MAVSDK (MAVLink/UDP) in, WebSocket out.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt
COPY bridge.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 8765
CMD ["python", "bridge.py"]
