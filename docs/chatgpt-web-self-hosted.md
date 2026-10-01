# Tự host Desktop Commander MCP cho ChatGPT Web

Chế độ `chatgpt-web` chạy một gateway MCP trên máy này. ChatGPT Web kết nối vào gateway qua HTTPS; gateway tạo một tiến trình Desktop Commander `stdio` riêng cho mỗi phiên MCP. Chế độ này không dùng Remote Desktop Commander, dashboard `mcp.desktopcommander.app`, hay lệnh `remote`.

## Yêu cầu

- Node.js 18 trở lên và bản Desktop Commander đã build.
- Một hostname công khai có DNS và TLS/HTTPS.
- Reverse proxy hoặc HTTPS ingress chuyển tiếp về `127.0.0.1:3000` trên máy đang chạy Desktop Commander.
- Một tài khoản đăng nhập duy nhất cho gateway.

Gateway chỉ bind `127.0.0.1`. Domain, chứng chỉ TLS và reverse proxy nằm ngoài tiến trình này; hiện repository không tạo hạ tầng công khai đó.

## Tạo mật khẩu OAuth

Từ checkout của repository:

```sh
npm ci
npm run build
node dist/index.js chatgpt-web hash-password
```

Nhập mật khẩu dài ít nhất 12 ký tự hai lần. Lệnh chỉ in ra hash scrypt; nó không in mật khẩu. Lưu hash trong secret manager hoặc cấu hình dịch vụ hệ điều hành, không commit vào repository và không đặt vào file cấu hình được theo dõi bởi Git.

## Chạy gateway

Cấu hình các biến môi trường sau trong môi trường dịch vụ của bạn:

| Biến | Bắt buộc | Giá trị |
|---|---:|---|
| `DC_CHATGPT_WEB_PUBLIC_URL` | Có | Origin HTTPS công khai, ví dụ `https://mcp.example.com` (không kèm `/mcp`) |
| `DC_CHATGPT_WEB_OAUTH_USERNAME` | Có | Username của tài khoản duy nhất |
| `DC_CHATGPT_WEB_OAUTH_PASSWORD_HASH` | Có | Hash scrypt tạo ở bước trên |
| `DC_CHATGPT_WEB_PORT` | Không | Cổng loopback; mặc định `3000` |

Chạy bằng bản build trong checkout:

```sh
node dist/index.js chatgpt-web
```

Sau khi tính năng được phát hành trong npm package, lệnh tương đương là:

```sh
desktop-commander chatgpt-web
```

Gateway in ra địa chỉ loopback và URL công khai dự kiến. Mỗi phiên tạo một stdio worker; gateway nhận tối đa 16 phiên đồng thời và đóng phiên không hoạt động sau 30 phút. OAuth client, mã xác thực, access token, refresh token và session MCP hiện được lưu trong bộ nhớ; khởi động lại gateway sẽ yêu cầu ChatGPT đăng ký/kết nối lại hoặc xác thực lại. Chạy một gateway instance cho mỗi URL vì session không được chia sẻ giữa nhiều tiến trình.

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
4. Chọn OAuth. ChatGPT sẽ đọc metadata, đăng ký OAuth client và mở trang đăng nhập của gateway.
5. Đăng nhập bằng username/password đã cấu hình, rồi hoàn tất kết nối.
6. Kiểm tra danh sách tools và gọi thử một tool đọc an toàn.

Tham khảo hướng dẫn OpenAI: [Build an MCP server](https://developers.openai.com/plugins/build/mcp-server), [Authentication](https://developers.openai.com/plugins/build/auth), và [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Hiện máy này chưa có DNS và HTTPS ingress công khai, nên có thể chạy và kiểm tra gateway cục bộ nhưng chưa thể xác nhận kết nối end-to-end từ ChatGPT Web. URL `https://<domain>/mcp` chỉ hoạt động sau khi domain và ingress được thiết lập.

## Quyền truy cập

Các tool chạy dưới quyền hệ điều hành của tiến trình gateway và stdio child. Desktop Commander có tool chạy lệnh tùy ý và đọc/ghi tệp; cấu hình `allowedDirectories: []` hiện cho phép truy cập filesystem rộng, còn blocklist và danh sách thư mục không phải sandbox. OAuth giới hạn người được phép gọi gateway, nhưng không giới hạn quyền hệ điều hành của tool. Nếu cần cô lập dữ liệu hoặc lệnh, chạy gateway dưới một tài khoản hệ điều hành riêng hoặc trong container/VM có quyền filesystem được giới hạn.
