# Include INSIDE the existing dashboard server block (port 8088).
location = /phpmyadmin { return 302 /phpmyadmin/; }
location ^~ /phpmyadmin/ {
    client_max_body_size 32m;
    proxy_pass http://127.0.0.1:8091;
    proxy_set_header Host $host;
    proxy_set_header Cookie $http_cookie;
    proxy_set_header X-Forwarded-Proto $nif_forwarded_proto;
    proxy_read_timeout 120s;
    # Ensure clients cannot cache pages after dashboard logout.
    proxy_hide_header Cache-Control;
    add_header Cache-Control "no-store" always;
}
