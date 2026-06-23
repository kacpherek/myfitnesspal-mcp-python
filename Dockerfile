FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MFP_MCP_TRANSPORT=streamable-http \
    PORT=8080

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/ ./src/

RUN pip install .
RUN useradd --create-home --shell /bin/bash mcp
USER mcp

EXPOSE 8080

CMD ["python", "-m", "mfp_mcp.server"]
