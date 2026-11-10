FROM golang:1.22-alpine AS build
WORKDIR /src
COPY . .
# dependencies are vendored: the build needs no network
RUN CGO_ENABLED=0 go build -mod=vendor -trimpath -ldflags="-s -w" -o /klap-realtime .

FROM scratch
COPY --from=build /klap-realtime /klap-realtime
EXPOSE 8001
ENTRYPOINT ["/klap-realtime"]
