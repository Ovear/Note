#!/bin/bash

wget -qO InstallNET.sh  'https://raw.githubusercontent.com/MoeClub/Note/master/InstallNET.sh' \
    && chmod a+x InstallNET.sh \
    && sed -i 's/d-i apt-setup\/services-select multiselect/d-i apt-setup\/services-select multiselect security, updates\nd-i apt-setup\/non-free boolean true\nd-i apt-setup\/contrib boolean true/g' InstallNET.sh \
    && sed -i 's/string US\/Eastern/string Asia\/Shanghai/g' InstallNET.sh \
    && sed -i 's/string openssh-server/string openssh-server build-essential sysstat dnsutils wget curl screen iptraf iftop vnstat git iperf3 mtr wireguard\nd-i iperf3\/start_daemon boolean false/g' InstallNET.sh \
    && sed -i 's/8.8.8.8/1.0.0.1/g' InstallNET.sh