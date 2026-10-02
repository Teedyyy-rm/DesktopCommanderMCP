# Tự host Desktop Commander MCP cho ChatGPT Web

Chế độ `chatgpt-web` chạy một gateway MCP trên máy này. ChatGPT Web kết nối vào gateway qua HTTPS; gateway tạo một tiến trình Desktop Commander `stdio` riêng cho mỗi phiên MCP. Chế độ này không dùng dịch vụ Remote MCP được lưu trữ bên ngoài hay lệnh `remote`.

## Yêu cầu

- Node.js 18 trở lên và bản Desktop Commander đã build.
- Một hostname công khai có DNS và TLS/HTTPS.
- Reverse proxy hoặc HTTPS ingress chuyển tiếp về `127.0.0.1:3000` trên máy đang chạy Desktop Commander.
- Một access key riêng cho gateway.

Gateway chỉ bind `127.0.0.1`. Domain, chứng chỉ TLS và reverse proxy nằm ngoài tiến trình này; hiện repository không tạo hạ tầng công khai đó.

## Có cần nhập access key không?

Không cần nhập key trong trình duyệt. Gateway đọc `DC_CHATGPT_WEB_OAUTH_KEY` từ môi trường riêng của service và dùng key đã cấu hình làm mặc định khi hoàn tất OAuth. Giá trị key không được đưa vào HTML. Trang xác thực chỉ cần bấm **Continue to ChatGPT**.

Giao dịch đăng nhập chờ không còn hết hạn sau 10 phút. Gateway chấp nhận gửi lại cùng một giao dịch sau khi đã hoàn tất: trước khi authorization code được đổi, nó trả lại cùng callback/code; sau khi đổi, nó báo rằng authorization đã hoàn tất. Authorization code vẫn dùng một lần, ràng buộc PKCE và có hạn 5 phút. Nếu có hơn 128 giao dịch cùng chờ, gateway loại giao dịch cũ nhất. Khởi động lại gateway vẫn xóa trạng thái OAuth đang giữ trong bộ nhớ, vì vậy hãy bắt đầu kết nối mới sau khi restart. Thời hạn access/refresh token là thiết lập riêng và không bị thay đổi bởi thời hạn giao dịch đăng nhập.

OAuth vẫn cấp bearer token và gateway kiểm tra token trên từng yêu cầu MCP. Vì gateway tự hoàn tất đăng nhập bằng key đã cấu hình, người nào biết URL và tự thêm connector ChatGPT có thể lấy quyền gọi tools; chỉ dùng chế độ này cho connector cá nhân và giữ kín endpoint. Các tools chạy dưới quyền hệ điều hành của máy này.

## Tạo access key

Sau khi build, chạy từ checkout của repository:

```sh
npm ci
npm run build
node dist/index.js chatgpt-web generate-key
```

Lệnh tự tạo access key ngẫu nhiên và ghi vào `~/.config/desktop-commander/chatgpt-web.env`, là file môi trường riêng mà service systemd có thể đọc. File được đặt quyền `600`; lệnh không in giá trị key ra terminal. Không cần copy key vào trình duyệt; service dùng giá trị trong file làm key mặc định. Lệnh giữ lại các cài đặt khác, loại bỏ username/hash password cũ và thay key hiện tại nếu chạy lại. Để dùng đường dẫn file khác, đặt `DC_CHATGPT_WEB_ENV_FILE` khi chạy lệnh. Khởi động lại gateway sau khi sinh hoặc xoay key, ví dụ `systemctl --user restart desktop-commander-chatgpt-web.service`.

## Chạy gateway

Cấu hình các biến môi trường sau trong môi trường dịch vụ của bạn:

| Biến | Bắt buộc | Giá trị |
|---|---:|---|
| `DC_CHATGPT_WEB_PUBLIC_URL` | Có | Origin HTTPS công khai, ví dụ `https://mcp.example.com` (không kèm `/mcp`) |
| `DC_CHATGPT_WEB_OAUTH_KEY` | Có | Key ngẫu nhiên do lệnh `generate-key` tạo |
| `DC_CHATGPT_WEB_PORT` | Không | Cổng loopback; mặc định `3000` |
| `DC_CHATGPT_WEB_CLIENTS_FILE` | Không | File JSON lưu đăng ký OAuth DCR; mặc định `~/.config/desktop-commander/chatgpt-web-oauth-clients.json` |

Chạy bằng bản build trong checkout:

```sh
node dist/index.js chatgpt-web
```

Sau khi tính năng được phát hành trong npm package, lệnh tương đương là:

```sh
desktop-commander chatgpt-web
```

Gateway in ra địa chỉ loopback và URL công khai dự kiến. Mỗi phiên tạo một stdio worker; gateway nhận tối đa 16 phiên đồng thời và đóng phiên không hoạt động sau 30 phút. Thông tin đăng ký OAuth DCR được lưu riêng trên đĩa với quyền `600`, để `client_id` do ChatGPT cấp vẫn dùng được sau khi gateway khởi động lại. Mã xác thực, access token, refresh token và session MCP vẫn chỉ nằm trong bộ nhớ; sau restart, ChatGPT cần bắt đầu authorization flow mới. Chạy một gateway instance cho mỗi URL vì session không được chia sẻ giữa nhiều tiến trình.

## Theo dõi và kiểm tra gateway

Trên Linux dùng systemd user service, xem log realtime bằng:

```sh
journalctl --user -u desktop-commander-chatgpt-web.service -n 100 -f
```

Mỗi lệnh ChatGPT gọi qua gateway tạo log nhận lệnh và log kết quả theo dạng của `desktop-commander remote`, ví dụ:

```text
🔧 Received tool call 81f...: start_process {"command":"pwd","timeout_ms":3000} metadata: {"transport":"streamable_http","clientInfo":{"name":"openai-mcp","version":"1.0.0"},"oauth_client_id":"...","origin_instance":"...","gateway_pid":1234,"session_id":"..."}
✅ Tool call start_process completed:
 {"content":[{"type":"text","text":"Process started with PID 1234 (shell: /usr/bin/zsh)\\nInitial output:\\n/home/obito/projects/DesktopCommanderMCP"}]}
```

Metadata ghi transport, client MCP thực tế, OAuth client, instance gateway và session MCP; khi không gọi được tool, journal ghi dòng `❌ Tool call ... failed`. Log này bao gồm arguments và nội dung kết quả giống terminal `remote`. Có thể kiểm tra gateway còn phục vụ HTTP bằng:

```sh
systemctl --user is-active desktop-commander-chatgpt-web.service
curl -fsS http://127.0.0.1:3000/healthz
```

`/healthz` chỉ xác nhận tiến trình gateway phản hồi HTTP; cặp dòng `🔧 Received tool call ...` và `✅ Tool call ... completed` sau thao tác thực tế xác nhận lệnh đã đi qua gateway tới tiến trình Desktop Commander local. Nếu chỉ thấy dòng nhận lệnh nhưng không thấy hoàn tất, xem dòng lỗi ngay sau đó để tìm nguyên nhân.

## Cấu hình HTTPS ingress

Chuyển tiếp nguyên các đường dẫn sau tới cùng một tiến trình gateway trên `127.0.0.1:<port>`:

- `/mcp` với các phương thức `POST`, `GET`, `DELETE`.
- `/authorize`, `/token`, `/register`, `/revoke`, `/login`.
- `/.well-known/oauth-authorization-server` và `/.well-known/oauth-protected-resource/mcp`.

Ingress phải giữ nguyên header `Authorization`, các header `Mcp-Session-Id` và `Mcp-Protocol-Version`, đồng thời không buffer phản hồi Streamable HTTP/SSE. TLS phải kết thúc trên hostname được khai báo trong `DC_CHATGPT_WEB_PUBLIC_URL`. Không ánh xạ cổng gateway trực tiếp ra Internet; chỉ reverse proxy công khai mới nhận HTTPS.

Ví dụ cấu hình Nginx tối thiểu cho phần chuyển tiếp (TLS certificate và virtual host cần được cấu hình riêng):

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

## Kết nối ChatGPT Web

1. Trong ChatGPT Web, bật **Developer mode** ở phần cài đặt Apps/Connectors.
2. Chọn tạo app mới và chọn **URL Server**.
3. Nhập `https://<domain-của-bạn>/mcp`.
4. Chọn OAuth. ChatGPT sẽ đọc metadata, đăng ký OAuth client và mở trang xác thực của gateway.
5. Bấm **Continue to ChatGPT**. Gateway dùng key đã nạp từ môi trường service; không cần copy/paste key.
6. Kiểm tra danh sách tools và gọi thử một tool đọc an toàn.

Tham khảo hướng dẫn OpenAI: [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server), [Authentication](https://developers.openai.com/plugins/build/auth), và [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Deployment hiện tại dùng DNS và HTTPS ingress tại `https://mcp.omniislabs.io.vn`; metadata OAuth công khai đã được kiểm tra. Đăng ký client được giữ qua restart; mỗi lần gateway khởi động lại, hãy bắt đầu một luồng ủy quyền OAuth mới vì transaction và token đang hoạt động vẫn được lưu trong bộ nhớ. Các deployment khác cần cấu hình DNS và HTTPS ingress riêng.

## Quyền truy cập

Các tool chạy dưới quyền hệ điều hành của tiến trình gateway và stdio child. Desktop Commander có tool chạy lệnh tùy ý và đọc/ghi tệp; cấu hình `allowedDirectories: []` hiện cho phép truy cập filesystem rộng, còn blocklist và danh sách thư mục không phải sandbox. OAuth giới hạn người được phép gọi gateway, nhưng không giới hạn quyền hệ điều hành của tool. Nếu cần cô lập dữ liệu hoặc lệnh, chạy gateway dưới một tài khoản hệ điều hành riêng hoặc trong container/VM có quyền filesystem được giới hạn.
