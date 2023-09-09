FROM shadowsocks/shadowsocks-libev:latest

USER root

RUN set -x \
    # Build environment setup
    && apk add --no-cache --virtual .build-deps \
        gcc \
        autoconf \
        make \
        libcap \
        libtool \
        automake \
        zlib-dev \
        openssl \
        asciidoc \
        xmlto \
        libpcre32 \
        libev-dev \
        g++ \
        linux-headers \
        git \
        # Fetch code
        && git clone https://github.com/shadowsocks/simple-obfs.git /tmp/repo \
        # Build & install
        && cd /tmp/repo \
        && git submodule update --init --recursive \
        && ./autogen.sh \
        && ./configure --prefix=/usr/local --disable-documentation \
        && make -j$(getconf _NPROCESSORS_ONLN) \
        && make install \
        && cd /usr/local/bin \
        && cd /usr/local/bin \
        && ls /usr/local/bin/obfs-* | xargs -n1 setcap cap_net_bind_service+ep \
        && strip $(ls /usr/local/bin | grep 'obfs-') \
        && apk del .build-deps \
        && apk add --no-cache \
        ca-certificates \
        rng-tools \
        tzdata \
        $(scanelf --needed --nobanner /usr/local/bin/obfs-* \
        | awk '{ gsub(/,/, "\nso:", $2); print "so:" $2 }' \
        | sort -u) \
        && rm -rf /tmp/repo

    USER nobody

    CMD exec ss-server \
      -s $SERVER_ADDR \
      -p $SERVER_PORT \
      -k ${PASSWORD:-$(hostname)} \
      -m $METHOD \
      -t $TIMEOUT \
      -d $DNS_ADDRS \
      -u \
      $ARGS

    EXPOSE 8388

    STOPSIGNAL SIGINT