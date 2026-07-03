FROM python:alpine
WORKDIR /app
RUN pip install --no-cache-dir flask "yt-dlp[default]"
RUN apk add --no-cache aria2 ffmpeg
COPY app/ /app/
EXPOSE 5000
CMD ["python", "webui.py"]
