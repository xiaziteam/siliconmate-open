FROM python:3.11-slim
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt pytest
COPY app.py models.py security.py inspector.py ./
RUN mkdir -p data logs certs
EXPOSE 8710
ENV ACCOUNT_DB=/srv/data/account.db MASTER_KEY=change-me PROBE_ENABLED=0
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8710", \
     "--ssl-keyfile", "/srv/certs/key.pem", "--ssl-certfile", "/srv/certs/cert.pem"]
