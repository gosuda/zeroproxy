package diagnostics

import (
	"context"
	"io"
	"log"
	"log/slog"
	"regexp"

	"github.com/gosuda/zeroproxy/internal/errorauthority"
)

const classificationRequestID = "diagnostic_record_0001"

var eventPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,63}$`)

type Logger struct {
	base *slog.Logger
}

func NewLogger(base *slog.Logger) *Logger {
	if base == nil {
		base = slog.Default()
	}
	return &Logger{base: base}
}

func (l *Logger) Failure(ctx context.Context, level slog.Level, event string, code errorauthority.ErrorCode, stage errorauthority.ErrorStage, _ error) {
	if l == nil || l.base == nil {
		return
	}
	if !eventPattern.MatchString(event) {
		event = "redacted_failure"
	}
	record, err := errorauthority.NewInternal(errorauthority.ErrorVersion, code, stage, classificationRequestID, nil)
	if err != nil {
		record, _ = errorauthority.NewInternal(errorauthority.ErrorVersion, errorauthority.CodeInternalFailed, errorauthority.StageInternal, classificationRequestID, nil)
	}
	l.base.LogAttrs(ctx, level, "zeroproxy failure",
		slog.String("event", event),
		slog.String("code", string(record.Code)),
		slog.String("stage", string(record.Stage)),
	)
}

func (l *Logger) DebugFailure(event string, code errorauthority.ErrorCode, stage errorauthority.ErrorStage, cause error) {
	l.Failure(context.Background(), slog.LevelDebug, event, code, stage, cause)
}

func (l *Logger) ErrorFailure(event string, code errorauthority.ErrorCode, stage errorauthority.ErrorStage, cause error) {
	l.Failure(context.Background(), slog.LevelError, event, code, stage, cause)
}

type redactingWriter struct {
	logger *Logger
}

func (w redactingWriter) Write(value []byte) (int, error) {
	w.logger.ErrorFailure("http_server_error", errorauthority.CodeServerHttpError, errorauthority.StageInternal, nil)
	return len(value), nil
}

func (l *Logger) HTTPErrorLog() *log.Logger {
	return log.New(redactingWriter{logger: l}, "", 0)
}

var _ io.Writer = redactingWriter{}
