set -eu
output=/work/user/script-output
log="$output/pointer.log"
n=1
while true; do
	request="$output/pointer-request-$n.txt"
	while [ ! -f "$request" ]; do sleep 0.2; done
	sleep 0.2
	read -r action x1 y1 x2 y2 < "$request"
	case "$action" in
	drag)
		echo "$(date -u +%FT%TZ) drag $x1,$y1 -> $x2,$y2" >> "$log"
		xdotool mousemove --sync "$x1" "$y1"
		sleep 0.1
		xdotool mousedown 1
		sleep 0.1
		i=1
		while [ "$i" -le 10 ]; do
			xdotool mousemove --sync $((x1 + (x2 - x1) * i / 10)) $((y1 + (y2 - y1) * i / 10))
			sleep 0.06
			i=$((i + 1))
		done
		xdotool mouseup 1
		sleep 0.1
		xdotool mousemove --sync 800 20
		;;
	click)
		echo "$(date -u +%FT%TZ) click $x1,$y1" >> "$log"
		xdotool mousemove --sync "$x1" "$y1"
		sleep 0.1
		xdotool click 1
		sleep 0.1
		xdotool mousemove --sync 800 20
		;;
	capture)
		case "$x1" in *[!A-Za-z0-9_.-]*|"") echo "bad capture name: $x1" >> "$log"; exit 1 ;; esac
		echo "$(date -u +%FT%TZ) capture $x1" >> "$log"
		xwd -root -silent -display "$DISPLAY" | xwdtopnm 2>/dev/null | pnmtopng > "$output/$x1.tmp"
		mv "$output/$x1.tmp" "$output/$x1"
		;;
	*)
		echo "unknown request: $action" >> "$log"
		exit 1
		;;
	esac
	echo "$(date -u +%FT%TZ) done $n" >> "$log"
	n=$((n + 1))
done
