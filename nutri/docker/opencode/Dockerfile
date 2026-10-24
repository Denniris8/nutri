FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin opencode \
  && mkdir -p /home/opencode/.config/opencode /home/opencode/.local/share/opencode /home/opencode/.local/state/opencode \
  && chown -R opencode:opencode /home/opencode/.config /home/opencode/.local

USER opencode
ENV HOME=/home/opencode PATH=/home/opencode/.opencode/bin:$PATH
RUN curl -fsSL https://opencode.ai/v2/install | bash -s -- --version 2.1.3 --no-modify-path

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
