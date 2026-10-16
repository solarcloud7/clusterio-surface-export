local ClusterPause = {}

function ClusterPause.set_paused(paused)
	if type(paused) ~= "boolean" then
		return {success = false, error = "paused must be true or false"}
	end
	game.tick_paused = paused
	return {success = true, paused = game.tick_paused}
end

return ClusterPause
