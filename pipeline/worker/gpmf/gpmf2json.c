/*
 * gpmf2json — GoPro GPMF telemetry as JSON on stdout.
 *
 * Built on GoPro's gpmf-parser demo MP4 reader and parser (tag v2.2.1,
 * MIT or Apache-2.0). See third_party/gpmf-parser/LICENSE-MIT and LICENSE-APACHE.
 *
 * Each sample is stamped with the MP4 payload window it came from
 * (GetPayloadTime): samples in a payload are spread evenly across that window.
 *
 * {"device":string|null,"streams":{"FOUR":{"units":string,"samples":[{"t":seconds,"v":number|array}]}}, "durationSec":number}
 * No GPMF track is an empty streams object and exit 0.
 *
 * --streams GPS5,GPS9 keeps only those FourCCs (default is every stream).
 * --decimate FOUR=Hz may be repeated. Each named stream is averaged into that many buckets per second.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#include "GPMF_parser.h"
#include "GPMF_mp4reader.h"

#define MAX_ELEM 16
#define MAX_STREAMS 64
#define MAX_UNITS 160

typedef struct Sample {
	double t;
	int n;
	double v[MAX_ELEM];
	char *str;
} Sample;

typedef struct Stream {
	char key[5];
	char units[MAX_UNITS];
	Sample *items;
	size_t count;
	size_t cap;
} Stream;

static Stream streams[MAX_STREAMS];
static int stream_count = 0;
static char device[128];
static char want_keys[32][5];
static int want_count = 0;
#define MAX_DECIMATE 8
/* A long clip at a few hundred hertz must not allocate a multi-gig bucket table. */
#define DECIMATE_BUCKET_CAP 250000
static char decimate_key[MAX_DECIMATE][5];
static double decimate_hz[MAX_DECIMATE];
static int decimate_count = 0;

static int stream_wanted(const char name[5]) {
	if (!want_count) return 1;
	for (int i = 0; i < want_count; i++) {
		if (strcmp(want_keys[i], name) == 0) return 1;
	}
	return 0;
}

static int finite_num(double v) {
	return isfinite(v);
}

static void json_escape(FILE *fp, const char *s) {
	fputc('"', fp);
	for (; s && *s; s++) {
		unsigned char c = (unsigned char)*s;
		if (c == '"' || c == '\\') {
			fputc('\\', fp);
			fputc(c, fp);
		} else if (c == '\n') {
			fputs("\\n", fp);
		} else if (c == '\r') {
			fputs("\\r", fp);
		} else if (c == '\t') {
			fputs("\\t", fp);
		} else if (c < 0x20) {
			fprintf(fp, "\\u%04x", c);
		} else if (c < 0x80) {
			fputc(c, fp);
		} else {
			/* GPMF unit strings are Latin-1 (µ, ²). JSON is UTF-8. */
			fputc((char)(0xc0 | (c >> 6)), fp);
			fputc((char)(0x80 | (c & 0x3f)), fp);
		}
	}
	fputc('"', fp);
}

static void json_num(FILE *fp, double v) {
	char buf[64];
	char *dot;
	char *end;
	if (!finite_num(v)) {
		fputs("null", fp);
		return;
	}
	snprintf(buf, sizeof buf, "%.8f", v);
	dot = strchr(buf, '.');
	if (dot) {
		end = buf + strlen(buf);
		while (end > dot + 1 && end[-1] == '0') end--;
		if (end > buf && end[-1] == '.') end--;
		*end = 0;
	}
	fputs(buf, fp);
}

static void fourcc_string(uint32_t key, char out[5]) {
	out[0] = (char)((key >> 0) & 0xff);
	out[1] = (char)((key >> 8) & 0xff);
	out[2] = (char)((key >> 16) & 0xff);
	out[3] = (char)((key >> 24) & 0xff);
	out[4] = 0;
	for (int i = 0; i < 4; i++) {
		unsigned char c = (unsigned char)out[i];
		if (c < 0x20 || c == '"' || c == '\\') out[i] = '_';
	}
}

static Stream *stream_for(const char key[5]) {
	for (int i = 0; i < stream_count; i++) {
		if (strcmp(streams[i].key, key) == 0) return &streams[i];
	}
	if (stream_count >= MAX_STREAMS) return NULL;
	Stream *s = &streams[stream_count++];
	memset(s, 0, sizeof *s);
	memcpy(s->key, key, 5);
	return s;
}

static int append_sample(Stream *s, Sample sample) {
	if (s->count == s->cap) {
		size_t cap = s->cap ? s->cap * 2 : 256;
		Sample *next = realloc(s->items, cap * sizeof(Sample));
		if (!next) return 0;
		s->items = next;
		s->cap = cap;
	}
	s->items[s->count++] = sample;
	return 1;
}

static void remember_device(GPMF_stream *ms) {
	char name[64];
	if (GPMF_DeviceName(ms, name, sizeof name) != GPMF_OK) return;
	if (!name[0]) return;
	if (!device[0]) {
		snprintf(device, sizeof device, "%s", name);
		return;
	}
	if (strstr(device, name)) return;
	size_t used = strlen(device);
	snprintf(device + used, sizeof device - used, ", %s", name);
}

static void remember_units(Stream *s, GPMF_stream *ms) {
	if (s->units[0]) return;
	GPMF_stream find;
	GPMF_CopyState(ms, &find);
	if (GPMF_FindPrev(&find, GPMF_KEY_SI_UNITS, GPMF_CURRENT_LEVEL | GPMF_TOLERANT) != GPMF_OK &&
		GPMF_FindPrev(&find, GPMF_KEY_UNITS, GPMF_CURRENT_LEVEL | GPMF_TOLERANT) != GPMF_OK) {
		return;
	}
	char *data = (char *)GPMF_RawData(&find);
	uint32_t ssize = GPMF_StructSize(&find);
	uint32_t repeat = GPMF_Repeat(&find);
	if (!data || !ssize || !repeat) return;
	if (ssize > 32) ssize = 32;
	char buf[MAX_UNITS];
	size_t used = 0;
	buf[0] = 0;
	for (uint32_t i = 0; i < repeat && i < 12; i++) {
		char piece[40];
		uint32_t n = 0;
		while (n < ssize && data[i * ssize + n] && n < sizeof piece - 1) {
			unsigned char c = (unsigned char)data[i * ssize + n];
			piece[n++] = (c >= 0x20 && c != '"' && c != '\\') ? (char)c : ' ';
		}
		piece[n] = 0;
		while (n > 0 && piece[n - 1] == ' ') piece[--n] = 0;
		if (!piece[0]) continue;
		int wrote = snprintf(buf + used, sizeof buf - used, "%s%s", used ? "," : "", piece);
		if (wrote < 0 || (size_t)wrote >= sizeof buf - used) break;
		used += (size_t)wrote;
	}
	snprintf(s->units, sizeof s->units, "%s", buf);
}

static void take_stream(GPMF_stream *ms, double in, double out) {
	uint32_t key = GPMF_Key(ms);
	char name[5];
	fourcc_string(key, name);
	if (!name[0] || !stream_wanted(name)) return;

	GPMF_SampleType type = GPMF_Type(ms);
	uint32_t samples = GPMF_Repeat(ms);
	uint32_t elements = GPMF_ElementsInStruct(ms);
	if (!samples) return;

	Stream *stream = stream_for(name);
	if (!stream) return;
	remember_units(stream, ms);

	if (type == GPMF_TYPE_STRING_ASCII || type == GPMF_TYPE_UTC_DATE_TIME || type == GPMF_TYPE_STRING_UTF8) {
		char *raw = (char *)GPMF_RawData(ms);
		uint32_t size = GPMF_RawDataSize(ms);
		if (!raw || !size || size > 1024) return;
		char *copy = calloc(1, size + 1);
		if (!copy) return;
		memcpy(copy, raw, size);
		Sample sample;
		memset(&sample, 0, sizeof sample);
		sample.t = (in + out) / 2.0;
		sample.str = copy;
		if (!append_sample(stream, sample)) free(copy);
		return;
	}

	if (!elements) elements = 1;
	uint32_t use_elem = elements > MAX_ELEM ? MAX_ELEM : elements;
	if (samples > 200000) return;
	size_t count = (size_t)samples * (size_t)elements;
	if (count > 2000000) return;
	double *scaled = malloc(count * sizeof(double));
	if (!scaled) return;
	uint32_t bytes = (uint32_t)(count * sizeof(double));
	if (GPMF_ScaledData(ms, scaled, bytes, 0, samples, GPMF_TYPE_DOUBLE) != GPMF_OK) {
		free(scaled);
		return;
	}
	for (uint32_t i = 0; i < samples; i++) {
		Sample sample;
		memset(&sample, 0, sizeof sample);
		double span = out - in;
		sample.t = samples == 1 ? (in + out) / 2.0 : in + span * ((double)i + 0.5) / (double)samples;
		sample.n = (int)use_elem;
		for (uint32_t j = 0; j < use_elem; j++) sample.v[j] = scaled[(size_t)i * elements + j];
		if (!append_sample(stream, sample)) break;
	}
	free(scaled);
}

/* Average one numeric stream into fixed-width buckets. Empty buckets are omitted. */
static void decimate_stream(Stream *s, double hz) {
	size_t i;
	int b0, b1;
	size_t nb;
	double *sum;
	int *cnt;
	int *elem;
	Sample *next;
	size_t count;
	if (hz <= 0 || !s->count || s->items[0].str) return;
	b0 = (int)floor(s->items[0].t * hz);
	b1 = (int)floor(s->items[s->count - 1].t * hz);
	if (b1 < b0) return;
	nb = (size_t)(b1 - b0) + 1;
	/* A long clip does not keep the full rate. Lower Hz until the buckets fit.
	   Returning here would emit every sample. */
	{
		int guard = 0;
		while (nb > DECIMATE_BUCKET_CAP && guard < 64) {
			double span = s->items[s->count - 1].t - s->items[0].t;
			double next;
			guard++;
			if (!(span > 0)) {
				b0 = 0;
				b1 = 0;
				nb = 1;
				hz = 1.0;
				break;
			}
			next = ((double)DECIMATE_BUCKET_CAP - 1.0) / span;
			if (!(next > 0) || next >= hz) next = hz * 0.5;
			if (!(next > 0)) {
				b0 = 0;
				b1 = 0;
				nb = 1;
				hz = 1.0;
				break;
			}
			hz = next;
			b0 = (int)floor(s->items[0].t * hz);
			b1 = (int)floor(s->items[s->count - 1].t * hz);
			if (b1 < b0) b1 = b0;
			nb = (size_t)(b1 - b0) + 1;
		}
		if (nb > DECIMATE_BUCKET_CAP) {
			b0 = 0;
			b1 = 0;
			nb = 1;
			if (!(hz > 0)) hz = 1.0;
		}
	}
	sum = calloc(nb * MAX_ELEM, sizeof(double));
	cnt = calloc(nb, sizeof(int));
	elem = calloc(nb, sizeof(int));
	if (!sum || !cnt || !elem) {
		free(sum);
		free(cnt);
		free(elem);
		return;
	}
	for (i = 0; i < s->count; i++) {
		Sample *sample = &s->items[i];
		int b;
		int n;
		int j;
		if (sample->str) continue;
		b = (int)floor(sample->t * hz) - b0;
		if (b < 0 || (size_t)b >= nb) continue;
		n = sample->n > 0 ? sample->n : 1;
		if (n > MAX_ELEM) n = MAX_ELEM;
		if (!elem[b]) elem[b] = n;
		n = elem[b];
		for (j = 0; j < n && j < sample->n; j++) sum[(size_t)b * MAX_ELEM + j] += sample->v[j];
		cnt[b]++;
	}
	next = calloc(nb, sizeof(Sample));
	if (!next) {
		free(sum);
		free(cnt);
		free(elem);
		return;
	}
	count = 0;
	for (i = 0; i < nb; i++) {
		Sample sample;
		int j;
		if (!cnt[i]) continue;
		memset(&sample, 0, sizeof sample);
		sample.t = ((double)(b0 + (int)i) + 0.5) / hz;
		sample.n = elem[i] > 0 ? elem[i] : 1;
		for (j = 0; j < sample.n; j++) sample.v[j] = sum[i * MAX_ELEM + j] / cnt[i];
		next[count++] = sample;
	}
	for (i = 0; i < s->count; i++) free(s->items[i].str);
	free(s->items);
	s->items = next;
	s->count = count;
	s->cap = nb;
	free(sum);
	free(cnt);
	free(elem);
}

static void emit(double duration) {
	fputc('{', stdout);
	fputs("\"device\":", stdout);
	if (device[0]) json_escape(stdout, device);
	else fputs("null", stdout);
	fputs(",\"streams\":{", stdout);
	int first_stream = 1;
	for (int i = 0; i < stream_count; i++) {
		Stream *s = &streams[i];
		if (!s->count) continue;
		if (!first_stream) fputc(',', stdout);
		first_stream = 0;
		json_escape(stdout, s->key);
		fputs(":{\"units\":", stdout);
		json_escape(stdout, s->units);
		fputs(",\"samples\":[", stdout);
		for (size_t n = 0; n < s->count; n++) {
			Sample *sample = &s->items[n];
			if (n) fputc(',', stdout);
			fputs("{\"t\":", stdout);
			json_num(stdout, sample->t);
			fputs(",\"v\":", stdout);
			if (sample->str) {
				json_escape(stdout, sample->str);
			} else if (sample->n <= 1) {
				json_num(stdout, sample->v[0]);
			} else {
				fputc('[', stdout);
				for (int j = 0; j < sample->n; j++) {
					if (j) fputc(',', stdout);
					json_num(stdout, sample->v[j]);
				}
				fputc(']', stdout);
			}
			fputc('}', stdout);
		}
		fputs("]}", stdout);
	}
	fprintf(stdout, "},\"durationSec\":");
	json_num(stdout, duration);
	fputs("}\n", stdout);
}

static void empty_doc(void) {
	fputs("{\"device\":null,\"streams\":{},\"durationSec\":0}\n", stdout);
}

static void usage(void) {
	fprintf(stderr, "usage: gpmf2json [--streams A,B] [--decimate FOUR=Hz]... <file>\n");
}

static int add_streams(const char *list) {
	char buf[256];
	char *p;
	snprintf(buf, sizeof buf, "%s", list);
	p = buf;
	while (*p) {
		char *comma = strchr(p, ',');
		if (comma) *comma = 0;
		if (want_count >= 32 || strlen(p) != 4) return 0;
		memcpy(want_keys[want_count], p, 4);
		want_keys[want_count][4] = 0;
		want_count++;
		if (!comma) break;
		p = comma + 1;
	}
	return want_count > 0;
}

static int set_decimate(const char *spec) {
	const char *eq = strchr(spec, '=');
	if (!eq || eq - spec != 4 || decimate_count >= MAX_DECIMATE) return 0;
	memcpy(decimate_key[decimate_count], spec, 4);
	decimate_key[decimate_count][4] = 0;
	decimate_hz[decimate_count] = atof(eq + 1);
	if (!(decimate_hz[decimate_count] > 0)) return 0;
	decimate_count++;
	return 1;
}

int main(int argc, char **argv) {
	const char *file = NULL;
	int i;
	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--streams") == 0) {
			if (i + 1 >= argc || !add_streams(argv[++i])) {
				usage();
				return 1;
			}
		} else if (strcmp(argv[i], "--decimate") == 0) {
			if (i + 1 >= argc || !set_decimate(argv[++i])) {
				usage();
				return 1;
			}
		} else if (argv[i][0] == '-') {
			usage();
			return 1;
		} else if (file) {
			usage();
			return 1;
		} else {
			file = argv[i];
		}
	}
	if (!file) {
		usage();
		return 1;
	}

	size_t mp4 = OpenMP4Source((char *)file, MOV_GPMF_TRAK_TYPE, MOV_GPMF_TRAK_SUBTYPE, 0);
	if (!mp4) {
		fprintf(stderr, "no GPMF track\n");
		empty_doc();
		return 0;
	}

	uint32_t payloads = GetNumberPayloads(mp4);
	double duration = GetDuration(mp4);
	mp4object *raw = (mp4object *)mp4;
	if (raw->videolength > duration) duration = raw->videolength;

	size_t payloadres = 0;
	GPMF_stream metadata;
	memset(&metadata, 0, sizeof metadata);
	GPMF_stream *ms = &metadata;

	for (uint32_t index = 0; index < payloads; index++) {
		double in = 0, out = 0;
		uint32_t payloadsize = GetPayloadSize(mp4, index);
		payloadres = GetPayloadResource(mp4, payloadres, payloadsize);
		uint32_t *payload = GetPayload(mp4, payloadres, index);
		if (!payload) continue;
		if (GetPayloadTime(mp4, index, &in, &out) != GPMF_OK) continue;
		if (GPMF_Init(ms, payload, payloadsize) != GPMF_OK) continue;

		GPMF_ERR ret = GPMF_FindNext(ms, GPMF_KEY_STREAM, GPMF_RECURSE_LEVELS | GPMF_TOLERANT);
		while (ret == GPMF_OK) {
			remember_device(ms);
			if (GPMF_SeekToSamples(ms) == GPMF_OK) take_stream(ms, in, out);
			ret = GPMF_FindNext(ms, GPMF_KEY_STREAM, GPMF_RECURSE_LEVELS | GPMF_TOLERANT);
		}
		GPMF_ResetState(ms);
	}

	for (int d = 0; d < decimate_count; d++) {
		for (int sidx = 0; sidx < stream_count; sidx++) {
			if (strcmp(streams[sidx].key, decimate_key[d]) == 0) decimate_stream(&streams[sidx], decimate_hz[d]);
		}
	}

	if (!stream_count) fprintf(stderr, "no GPMF track\n");
	emit(duration > 0 ? duration : 0);

	if (payloadres) FreePayloadResource(mp4, payloadres);
	GPMF_Free(ms);
	CloseSource(mp4);
	for (int i = 0; i < stream_count; i++) {
		for (size_t n = 0; n < streams[i].count; n++) free(streams[i].items[n].str);
		free(streams[i].items);
	}
	return 0;
}
